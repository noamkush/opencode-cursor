import http from "node:http";
import http2 from "node:http2";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  GetUsableModelsResponseSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";
import {
  GetEffectiveTokenLimitRequestSchema,
  GetEffectiveTokenLimitResponseSchema,
} from "../src/proto/aiserver_pb";
import { normalizeGlobArgs } from "../src/native-tools";

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
  setEffectiveTokenLimits: (limits: Record<string, number>) => void;
  resetObservations: () => void;
  getEffectiveTokenLimitRequests: () => string[];
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
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

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  let effectiveTokenLimits: Record<string, number> = {};
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
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
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.end();
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
    setEffectiveTokenLimits(limits) {
      effectiveTokenLimits = { ...limits };
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      effectiveTokenLimitRequests.length = 0;
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

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    testNormalizeGlobArgs();
    await testProxyStartStop(modules);
    testHeartbeatClassification(modules);
    testConnectFrameParserHandoff(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testCursorSystemInstructions(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testModelLimitCache(modules, backend);
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
