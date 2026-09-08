import http from "node:http";
import http2 from "node:http2";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  ExecServerMessageSchema,
  GetUsableModelsResponseSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  ModelDetailsSchema,
  type AgentServerMessage,
} from "../src/proto/agent_pb";
import {
  GetEffectiveTokenLimitRequestSchema,
  GetEffectiveTokenLimitResponseSchema,
} from "../src/proto/aiserver_pb";
import { normalizeEditArgs, normalizeFilePathArgs, normalizeGlobArgs, normalizeWriteArgs, unwrapReadOutput } from "../src/native-tools";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  createConnectFrameParser: typeof import("../src/proxy").createConnectFrameParser;
  isCursorServerHeartbeat: typeof import("../src/proxy").isCursorServerHeartbeat;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  setHoldRunStream: (hold: boolean) => void;
  setRunFrames: (frames: Buffer[]) => void;
  writeRunFrames: (frames: Buffer[]) => void;
  endRunStreams: () => void;
  setEffectiveTokenLimits: (limits: Record<string, number>) => void;
  resetObservations: () => void;
  getEffectiveTokenLimitRequests: () => string[];
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  waitForRunStreamClose: () => Promise<void>;
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** A Connect-framed text delta, enough to make the proxy emit its first SSE chunk. */
function frameRunTextDelta(text: string): Buffer {
  return frameAgentMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: { case: "textDelta", value: { text } },
        }),
      },
    }),
  );
}

function frameAgentMessage(message: AgentServerMessage): Buffer {
  return frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, message));
}

function frameCheckpoint(usedTokens: number, maxTokens = 256_000): Buffer {
  return frameAgentMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "conversationCheckpointUpdate",
        value: create(ConversationStateStructureSchema, {
          tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens, maxTokens }),
        }),
      },
    }),
  );
}

function frameTokenDelta(tokens: number): Buffer {
  return frameAgentMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: { case: "tokenDelta", value: { tokens } },
        }),
      },
    }),
  );
}

function frameMcpExec(toolCallId: string, toolName = "read", id = 1): Buffer {
  return frameAgentMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id,
          execId: `exec-${id}`,
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, {
              name: toolName,
              toolName,
              toolCallId,
            }),
          },
        }),
      },
    }),
  );
}

async function collectSseEvents(res: Response): Promise<any[]> {
  const text = await res.text();
  const events: any[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("data: "));
    if (!line) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data));
  }
  return events;
}

function lastUsage(events: any[]): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.usage) return events[i].usage;
  }
  return undefined;
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  let effectiveTokenLimits: Record<string, number> = {};
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  let runStreamClosed = Promise.withResolvers<void>();
  const heldRunStreams = new Set<http2.ServerHttp2Stream>();
  let holdRunStream = false;
  let runFrames: Buffer[] | null = null;
  const refreshAuthHeaders: string[] = [];
  const effectiveTokenLimitRequests: string[] = [];

  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      const closed = runStreamClosed;
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.on("close", () => {
        heldRunStreams.delete(stream);
        closed.resolve();
      });
      if (runFrames) {
        for (const frame of runFrames) stream.write(frame);
      } else if (holdRunStream) {
        // Cancellation can only be observed on a stream still running when the
        // client goes away. Bun also withholds SSE response headers until the
        // first body byte, so emit one to unblock the caller's fetch.
        stream.write(frameRunTextDelta("streaming"));
      }
      if (holdRunStream) {
        heldRunStreams.add(stream);
      } else {
        stream.end();
      }
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(
              toBinary(
                GetUsableModelsResponseSchema,
                create(GetUsableModelsResponseSchema, {
                  models: discoveredModels.map((model) =>
                    create(ModelDetailsSchema, {
                      modelId: model.id,
                      displayModelId: model.id,
                      displayName: model.name,
                      displayNameShort: model.name,
                      aliases: [],
                    }),
                  ),
                }),
              ),
            );
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      if (path === "/aiserver.v1.AiService/GetEffectiveTokenLimit") {
        const request = fromBinary(
          GetEffectiveTokenLimitRequestSchema,
          new Uint8Array(Buffer.concat(chunks)),
        );
        const modelId = request.modelDetails?.modelName ?? "";
        effectiveTokenLimitRequests.push(modelId);
        const tokenLimit = effectiveTokenLimits[modelId] ?? 0;
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(
          frameConnectUnaryMessage(
            toBinary(
              GetEffectiveTokenLimitResponseSchema,
              create(GetEffectiveTokenLimitResponseSchema, { tokenLimit }),
            ),
          ),
        );
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    setHoldRunStream(hold) {
      holdRunStream = hold;
      if (!hold) {
        for (const stream of heldRunStreams) stream.close();
      }
    },
    setRunFrames(frames) {
      runFrames = frames;
    },
    writeRunFrames(frames) {
      for (const stream of heldRunStreams) {
        for (const frame of frames) stream.write(frame);
      }
    },
    endRunStreams() {
      for (const stream of heldRunStreams) stream.end();
    },
    setEffectiveTokenLimits(limits) {
      effectiveTokenLimits = { ...limits };
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      runStreamClosed = Promise.withResolvers<void>();
      effectiveTokenLimitRequests.length = 0;
      runFrames = null;
    },
    waitForRunStreamClose() {
      return runStreamClosed.promise;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getEffectiveTokenLimitRequests() {
      return [...effectiveTokenLimitRequests];
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    createConnectFrameParser: proxy.createConnectFrameParser,
    isCursorServerHeartbeat: proxy.isCursorServerHeartbeat,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

function testNormalizeGlobArgs() {
  console.log("[test] normalizeGlobArgs...");
  assertEqual(
    JSON.stringify(normalizeGlobArgs({ globPattern: "**/*.ts" })),
    JSON.stringify({ pattern: "**/*.ts" }),
    "Expected globPattern to become pattern",
  );
  assertEqual(
    JSON.stringify(
      normalizeGlobArgs({
        glob_pattern: "src/**/*.ts",
        target_directory: "/tmp",
      }),
    ),
    JSON.stringify({ pattern: "src/**/*.ts", path: "/tmp" }),
    "Expected glob_pattern and target_directory aliases",
  );
  assertEqual(
    JSON.stringify(normalizeGlobArgs({ pattern: "**/*.ts", path: "." })),
    JSON.stringify({ pattern: "**/*.ts", path: "." }),
    "Expected OpenCode glob args to pass through",
  );
  console.log("[test] normalizeGlobArgs OK");
}

function testNormalizeFilePathArgs() {
  console.log("[test] normalizeFilePathArgs...");
  assertEqual(
    JSON.stringify(normalizeFilePathArgs({ path: "/tmp/a.ts", limit: 80 })),
    JSON.stringify({ limit: 80, filePath: "/tmp/a.ts" }),
    "Expected path and limit to become filePath",
  );
  assertEqual(
    JSON.stringify(normalizeFilePathArgs({ filepath: "/tmp/b.ts" })),
    JSON.stringify({ filePath: "/tmp/b.ts" }),
    "Expected filepath alias to become filePath",
  );
  assertEqual(
    JSON.stringify(normalizeFilePathArgs({ filePath: "/tmp/c.ts" })),
    JSON.stringify({ filePath: "/tmp/c.ts" }),
    "Expected OpenCode filePath args to pass through",
  );
  assertEqual(
    JSON.stringify(normalizeFilePathArgs({ filePath: "/tmp/keep.ts", path: "/tmp/drop.ts" })),
    JSON.stringify({ filePath: "/tmp/keep.ts" }),
    "Expected existing filePath to win over path",
  );
  console.log("[test] normalizeFilePathArgs OK");
}

function opencodeReadOutput(path: string, lines: readonly string[], footer: string): string {
  return [
    `<path>${path}</path>`,
    "<type>file</type>",
    "<content>",
    ...lines.map((line, index) => `${index + 1}: ${line}`),
    "",
    footer,
    "</content>",
  ].join("\n");
}

function testUnwrapReadOutput() {
  console.log("[test] unwrapReadOutput...");
  const lines = ["import abc", "import logging"];
  const envelope = opencodeReadOutput(
    "/tmp/a.py",
    lines,
    "(End of file - total 2 lines)",
  );
  assertEqual(
    unwrapReadOutput(envelope),
    lines.join("\n"),
    "Expected a file envelope to unwrap to raw content",
  );

  const nested = opencodeReadOutput(
    "/tmp/a.py",
    envelope.split("\n"),
    "(End of file - total 8 lines)",
  );
  assertEqual(
    unwrapReadOutput(nested),
    envelope,
    "Expected a nested envelope to unwrap one layer",
  );

  assertEqual(
    unwrapReadOutput("plain text"),
    "plain text",
    "Expected non-envelope text to pass through",
  );
  assertEqual(
    unwrapReadOutput(["12: const x = 1", "13: const y = 2"].join("\n")),
    ["const x = 1", "const y = 2"].join("\n"),
    "Expected numbered Read lines without an envelope to be stripped",
  );
  assertEqual(
    unwrapReadOutput(["  12|foo", "  13|bar"].join("\n")),
    ["foo", "bar"].join("\n"),
    "Expected Cursor Read prefixes to be stripped",
  );
  assertEqual(
    unwrapReadOutput(["1: still real content", "const x = 1"].join("\n")),
    ["1: still real content", "const x = 1"].join("\n"),
    "Expected mixed lines to keep Read-like prefixes",
  );
  assertEqual(
    unwrapReadOutput(
      opencodeReadOutput(
        "/tmp/a.py",
        lines,
        "(Showing lines 1-2 of 10. Use offset=3 to continue.)",
      ),
    ),
    lines.join("\n"),
    "Expected truncation footer to be dropped",
  );
  assertEqual(
    unwrapReadOutput(`${envelope}\n\n<system-reminder>\nnote\n</system-reminder>`),
    lines.join("\n"),
    "Expected system-reminder after the envelope to be dropped",
  );
  console.log("[test] unwrapReadOutput OK");
}

function testNormalizeEditArgs() {
  console.log("[test] normalizeEditArgs...");
  assertEqual(
    JSON.stringify(
      normalizeEditArgs({
        filePath: "/tmp/a.ts",
        old_string: "before",
        new_string: "after",
        replace_all: true,
      }),
    ),
    JSON.stringify({
      filePath: "/tmp/a.ts",
      oldString: "before",
      newString: "after",
      replaceAll: true,
    }),
    "Expected snake_case edit args to become camelCase",
  );
  assertEqual(
    JSON.stringify(
      normalizeEditArgs({
        oldString: "keep",
        newString: "next",
        old_string: "drop",
        new_string: "drop",
      }),
    ),
    JSON.stringify({ oldString: "keep", newString: "next" }),
    "Expected existing camelCase edit args to win",
  );
  assertEqual(
    JSON.stringify(
      normalizeEditArgs({
        old_string: opencodeReadOutput("/tmp/a.ts", ["before"], "(End of file - total 1 lines)"),
        new_string: opencodeReadOutput("/tmp/a.ts", ["after"], "(End of file - total 1 lines)"),
      }),
    ),
    JSON.stringify({ oldString: "before", newString: "after" }),
    "Expected edit args copied from Read output to unwrap",
  );
  console.log("[test] normalizeEditArgs OK");
}

function testNormalizeWriteArgs() {
  console.log("[test] normalizeWriteArgs...");
  const content = ["import abc", "import logging"].join("\n");
  assertEqual(
    JSON.stringify(
      normalizeWriteArgs({
        filePath: "/tmp/a.py",
        content: opencodeReadOutput("/tmp/a.py", content.split("\n"), "(End of file - total 2 lines)"),
      }),
    ),
    JSON.stringify({ filePath: "/tmp/a.py", content }),
    "Expected write content envelopes to unwrap",
  );
  assertEqual(
    JSON.stringify(normalizeWriteArgs({ filePath: "/tmp/a.py", content })),
    JSON.stringify({ filePath: "/tmp/a.py", content }),
    "Expected plain write content to pass through",
  );
  console.log("[test] normalizeWriteArgs OK");
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testStreamCancellationStopsBridge(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing SSE cancellation teardown...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  const controller = new AbortController();
  try {
    const port = await modules.startProxy(async () => "test-token");
    const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }
    assertEqual(res.status, 200, "Expected a streaming response");

    controller.abort();
    // The bridge subprocess holds the only handle on this Run stream, so its
    // closure proves the subprocess was killed.
    await withTimeout(
      backend.waitForRunStreamClose(),
      "the Cursor Run stream to close after the client disconnects",
    );
  } finally {
    controller.abort();
    modules.stopProxy();
    backend.setHoldRunStream(false);
  }
  console.log("[test] SSE cancellation teardown OK");
}

function testHeartbeatClassification(modules: TestModules) {
  console.log("[test] Testing Cursor heartbeat classification...");
  const heartbeat = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema) },
      }),
    },
  });
  const text = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: { text: "progress" } },
      }),
    },
  });

  assert(modules.isCursorServerHeartbeat(heartbeat), "Expected heartbeat to be classified as non-progress");
  assert(!modules.isCursorServerHeartbeat(text), "Expected text delta to be classified as progress");
  console.log("[test] Cursor heartbeat classification OK");
}

function testConnectFrameParserHandoff(modules: TestModules) {
  console.log("[test] Testing Connect frame parser handoff...");
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema) },
      }),
    },
  });
  const frame = frameConnectUnaryMessage(toBinary(AgentServerMessageSchema, message));
  const parser = modules.createConnectFrameParser();
  const received: Uint8Array[] = [];

  parser.setHandlers((bytes) => received.push(bytes), () => {});
  parser.process(frame.subarray(0, 3));
  parser.setHandlers((bytes) => received.push(bytes), () => {});
  parser.process(frame.subarray(3));

  assertEqual(received.length, 1, "Expected one message after parser handoff");
  const decoded = fromBinary(AgentServerMessageSchema, received[0]!);
  assert(modules.isCursorServerHeartbeat(decoded), "Expected handed-off frame to decode as heartbeat");
  console.log("[test] Connect frame parser handoff OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testCursorSystemInstructions(modules: TestModules) {
  console.log("[test] Testing Cursor-only system instructions...");
  const hooks = await modules.CursorAuthPlugin({
    client: { auth: { set: async () => {} } },
  } as any);
  const transform = hooks["experimental.chat.system.transform"];
  assert(transform, "Plugin hooks missing system transform");

  const cursorSystem = ["Base system prompt"];
  await transform(
    { model: { providerID: "cursor" } as any },
    { system: cursorSystem },
  );
  assertEqual(cursorSystem.length, 2, "Expected Cursor system instructions to be appended");
  assert(
    cursorSystem[1]?.includes("delegate each area to a separate\nsubagent"),
    "Expected embedded delegation instructions for Cursor",
  );
  assert(
    cursorSystem[1]?.includes("Do not duplicate delegated investigation"),
    "Expected embedded duplicate-investigation instruction for Cursor",
  );
  assert(
    cursorSystem[1]?.includes("relative paths are relative to the Working directory"),
    "Expected embedded apply_patch path instruction for Cursor",
  );

  const otherSystem = ["Base system prompt"];
  await transform(
    { model: { providerID: "openai" } as any },
    { system: otherSystem },
  );
  assertArrayEqual(otherSystem, ["Base system prompt"], "Expected non-Cursor system prompt unchanged");
  console.log("[test] Cursor-only system instructions OK");
}


async function testApplyPatchPathRewrite(modules: TestModules) {
  console.log("[test] apply_patch path rewrite...");
  const hooks = await modules.CursorAuthPlugin({
    client: { auth: { set: async () => {} } },
    directory: "/repo/packages/opencode",
    worktree: "/repo",
  } as any);
  const before = hooks["tool.execute.before"];
  assert(before, "Plugin hooks missing tool.execute.before");

  const workspaceRelative =
    "*** Begin Patch\n*** Update File: packages/opencode/src/foo.ts\n@@\n-a\n+b\n*** End Patch";

  const output = { args: { patchText: workspaceRelative } };
  await before({ tool: "apply_patch", sessionID: "s", callID: "c" }, output);
  assertEqual(
    output.args.patchText,
    workspaceRelative,
    "Expected missing files to be left unchanged",
  );

  const patchOutput = { args: { patchText: workspaceRelative } };
  await before({ tool: "patch", sessionID: "s", callID: "c" }, patchOutput);
  assertEqual(
    patchOutput.args.patchText,
    workspaceRelative,
    "Expected patch tool to use the same rewrite",
  );

  const other = { args: { filePath: "packages/opencode/src/foo.ts" } };
  await before({ tool: "read", sessionID: "s", callID: "c" }, other);
  assertEqual(
    other.args.filePath,
    "packages/opencode/src/foo.ts",
    "Expected non-patch tools to be left unchanged",
  );
  console.log("[test] apply_patch path rewrite OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assertArrayEqual(
    Object.keys(provider.models),
    ["auto", "fresh-model"],
    "Expected provider models to come from successful discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await hooks.auth!.loader(async () => authState, provider);
  assert(
    Object.keys(provider.models).length > 0,
    "Expected fallback models to be registered when discovery fails",
  );
  assert(
    !("stale" in provider.models),
    "Expected stale models to be replaced",
  );
  const degradedModelsRes = await fetch(`${degradedConfig.baseURL}/models`);
  assertEqual(degradedModelsRes.status, 200, "Expected degraded /v1/models to succeed");
  const degradedModelsBody = await degradedModelsRes.json();
  assert(
    degradedModelsBody.data.length > 0,
    "Expected proxy /v1/models to expose fallback models",
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  backend.setEffectiveTokenLimits({ "real-model-a": 123_456 });
  const discoveredConfig = await hooks.auth!.loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected successful discovery to replace fallback models",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredModelsBody = await discoveredModelsRes.json();
  assertArrayEqual(
    discoveredModelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected proxy /v1/models to expose discovered models",
  );
  assertEqual(
    provider.models["real-model-a"]?.limit?.context,
    123_456,
    "Expected the server-provided effective token limit to be registered",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}

async function testModelLimitCache(modules: TestModules, backend: TestCursorBackend) {
  console.log("[test] Testing model limit cache...");
  const cacheDir = await mkdtemp(join(tmpdir(), "opencode-cursor-cache-"));
  const cachePath = join(cacheDir, "opencode-cursor", "model-limits.json");
  const freshAt = Date.now();
  const expiredAt = freshAt - 8 * 24 * 60 * 60 * 1_000;
  process.env.XDG_CACHE_HOME = cacheDir;

  async function setCache(models: Record<string, { refreshedAt: number; limit: number }>) {
    await mkdir(join(cacheDir, "opencode-cursor"), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ version: 1, models }));
  }

  async function waitForCachedLimit(modelId: string, limit: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const cache = JSON.parse(await readFile(cachePath, "utf8"));
        if (cache.models[modelId]?.limit === limit) return;
      } catch {
        // The asynchronous atomic write may not have completed yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${modelId} cache entry to be saved`);
  }

  try {
    backend.setDiscoveryMode("success");
    backend.setDiscoveredModels([{ id: "cached-model", name: "Cached Model" }]);
    backend.setEffectiveTokenLimits({ "cached-model": 222_222 });
    await setCache({ "cached-model": { refreshedAt: freshAt, limit: 111_111 } });
    backend.resetObservations();
    modules.clearModelCache();
    const freshModels = await modules.getCursorModels("test-token");
    assertEqual(freshModels.find((model) => model.id === "cached-model")?.contextWindow, 111_111, "Expected fresh cached limit");
    assertArrayEqual(backend.getEffectiveTokenLimitRequests(), [], "Expected fresh cache to avoid limit RPC");

    backend.setDiscoveredModels([{ id: "missing-model", name: "Missing Model" }]);
    backend.setEffectiveTokenLimits({ "missing-model": 123_456 });
    await setCache({});
    backend.resetObservations();
    modules.clearModelCache();
    const missingModels = await modules.getCursorModels("test-token");
    assertEqual(missingModels.find((model) => model.id === "missing-model")?.contextWindow, 123_456, "Expected missing model to resolve");
    assertArrayEqual(backend.getEffectiveTokenLimitRequests(), ["missing-model"], "Expected missing model limit RPC");
    await waitForCachedLimit("missing-model", 123_456);

    backend.setDiscoveredModels([{ id: "expired-model", name: "Expired Model" }]);
    backend.setEffectiveTokenLimits({ "expired-model": 234_567 });
    await setCache({ "expired-model": { refreshedAt: expiredAt, limit: 123_456 } });
    backend.resetObservations();
    modules.clearModelCache();
    const expiredModels = await modules.getCursorModels("test-token");
    assertEqual(expiredModels.find((model) => model.id === "expired-model")?.contextWindow, 234_567, "Expected expired limit to refresh");
    await waitForCachedLimit("expired-model", 234_567);

    backend.setDiscoveredModels([{ id: "failed-model", name: "Failed Model" }]);
    backend.setEffectiveTokenLimits({});
    await setCache({ "failed-model": { refreshedAt: expiredAt, limit: 345_678 } });
    backend.resetObservations();
    modules.clearModelCache();
    const failedModels = await modules.getCursorModels("test-token");
    assertEqual(failedModels.find((model) => model.id === "failed-model")?.contextWindow, 345_678, "Expected failed refresh to retain cached limit");

    backend.setDiscoveredModels([{ id: "corrupt-model", name: "Corrupt Model" }]);
    backend.setEffectiveTokenLimits({ "corrupt-model": 456_789 });
    await writeFile(cachePath, "not json");
    backend.resetObservations();
    modules.clearModelCache();
    const corruptModels = await modules.getCursorModels("test-token");
    assertEqual(corruptModels.find((model) => model.id === "corrupt-model")?.contextWindow, 456_789, "Expected corrupt cache to be ignored");
    assertArrayEqual(backend.getEffectiveTokenLimitRequests(), ["corrupt-model"], "Expected corrupt cache to trigger limit RPC");
  } finally {
    delete process.env.XDG_CACHE_HOME;
    await rm(cacheDir, { recursive: true, force: true });
  }
  console.log("[test] Model limit cache OK");
}


async function postChat(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function testUsageFromCheckpointAndTokenDelta(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing occupancy usage on stop...");
  backend.resetObservations();
  backend.setHoldRunStream(false);
  backend.setRunFrames([frameCheckpoint(10_000), frameTokenDelta(100)]);
  try {
    const port = await modules.startProxy(async () => "test-token");
    const res = await postChat(port, {
      model: "composer-2",
      stream: true,
      messages: [{ role: "user", content: "occupancy-stop-usage" }],
    });
    assertEqual(res.status, 200, "Expected streaming completion");
    const usage = lastUsage(await collectSseEvents(res));
    assert(usage, "Expected a usage chunk");
    assertEqual(usage.prompt_tokens, 9_900, "Expected occupancy minus output");
    assertEqual(usage.completion_tokens, 100, "Expected summed token deltas");
    assertEqual(usage.total_tokens, 10_000, "Expected checkpoint used_tokens");
  } finally {
    modules.stopProxy();
    backend.resetObservations();
  }
  console.log("[test] Occupancy usage on stop OK");
}

async function testUsageOnToolCallsAndResume(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing occupancy usage on tool calls and resume...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  backend.setRunFrames([frameCheckpoint(10_000), frameMcpExec("call-occupancy")]);
  try {
    const port = await modules.startProxy(async () => "test-token");
    const first = await postChat(port, {
      model: "composer-2",
      stream: true,
      messages: [{ role: "user", content: "occupancy-tool-usage" }],
    });
    assertEqual(first.status, 200, "Expected streaming tool-call completion");
    const firstUsage = lastUsage(await collectSseEvents(first));
    assert(firstUsage, "Expected usage on tool_calls finish");
    assertEqual(firstUsage.prompt_tokens, 9_999, "Expected occupancy with placeholder output");
    assertEqual(firstUsage.completion_tokens, 1, "Expected placeholder output so OpenCode shows context");
    assertEqual(firstUsage.total_tokens, 10_000, "Expected checkpoint used_tokens on tool_calls");

    const second = await postChat(port, {
      model: "composer-2",
      stream: true,
      messages: [
        { role: "user", content: "occupancy-tool-usage" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-occupancy",
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call-occupancy", content: "ok" },
      ],
    });
    assertEqual(second.status, 200, "Expected resumed streaming completion");
    backend.writeRunFrames([frameTokenDelta(50)]);
    backend.endRunStreams();
    const secondUsage = lastUsage(await collectSseEvents(second));
    assert(secondUsage, "Expected usage after resume");
    assertEqual(secondUsage.prompt_tokens, 9_950, "Expected occupancy minus new output");
    assertEqual(secondUsage.completion_tokens, 50, "Expected resume token deltas");
    assertEqual(secondUsage.total_tokens, 10_000, "Expected occupancy to survive resume without a new checkpoint");
  } finally {
    modules.stopProxy();
    backend.setHoldRunStream(false);
    backend.resetObservations();
  }
  console.log("[test] Occupancy usage on tool calls and resume OK");
}

async function testMissingParallelResultIsReemitted(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing missing parallel result recovery...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  backend.setRunFrames([
    frameMcpExec("call-first", "read", 1),
    frameMcpExec("call-late", "skill", 2),
  ]);
  try {
    const port = await modules.startProxy(async () => "test-token");
    const first = await postChat(port, {
      model: "composer-2",
      stream: true,
      messages: [{ role: "user", content: "parallel-result-recovery" }],
    });
    await collectSseEvents(first);

    const second = await postChat(port, {
      model: "composer-2",
      stream: true,
      messages: [
        { role: "user", content: "parallel-result-recovery" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-first", type: "function", function: { name: "read", arguments: "{}" } },
            { id: "call-late", type: "function", function: { name: "skill", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-first", content: "ok" },
      ],
    });
    const events = await collectSseEvents(second);
    const toolCallIds = events.flatMap((event) =>
      event.choices?.flatMap((choice: any) =>
        choice.delta?.tool_calls?.map((call: any) => call.id) ?? []
      ) ?? []
    );
    assertArrayEqual(toolCallIds, ["call-late"], "Expected missing parallel call to be re-emitted");
    assert(
      !JSON.stringify(events).includes("Tool result not provided"),
      "Expected no fabricated tool failure",
    );
  } finally {
    modules.stopProxy();
    backend.setHoldRunStream(false);
    backend.resetObservations();
  }
  console.log("[test] Missing parallel result recovery OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    testNormalizeGlobArgs();
    testNormalizeFilePathArgs();
    testUnwrapReadOutput();
    testNormalizeEditArgs();
    testNormalizeWriteArgs();
    await testProxyStartStop(modules);
    await testStreamCancellationStopsBridge(modules, backend);
    testHeartbeatClassification(modules);
    testConnectFrameParserHandoff(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testCursorSystemInstructions(modules);
    await testApplyPatchPathRewrite(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testModelLimitCache(modules, backend);
    await testUsageFromCheckpointAndTokenDelta(modules, backend);
    await testUsageOnToolCallsAndResume(modules, backend);
    await testMissingParallelResultIsReemitted(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
