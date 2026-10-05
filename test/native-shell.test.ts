import { describe, expect, test } from "bun:test";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { redirectNativeExec, sendNativeExecResult } from "../src/native-tools";
import { handleExecMessage, type PendingExec } from "../src/proxy";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  McpToolDefinitionSchema,
  ShellArgsSchema,
} from "../src/proto/agent_pb";

function tool(name: string, properties: Record<string, unknown>) {
  return create(McpToolDefinitionSchema, {
    name, toolName: name,
    inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties })),
  });
}

function request(kind: "shellArgs" | "shellStreamArgs", args = {}) {
  return create(ExecServerMessageSchema, {
    id: 42, execId: "shell-exec",
    message: { case: kind, value: create(ShellArgsSchema, { command: "echo hi", ...args }) },
  });
}

const properties = { command: { type: "string" }, workdir: { type: "string" }, timeout: { type: "number" } };

describe("native shell redirection", () => {
  for (const name of ["bash", "shell"]) {
    for (const kind of ["shellArgs", "shellStreamArgs"] as const) {
      test(`redirects ${kind} to advertised ${name} without undeclared arguments`, () => {
        const execs: PendingExec[] = [];
        const frames: Uint8Array[] = [];
        handleExecMessage(request(kind, { workingDirectory: "/repo", timeout: 1000 }),
          [tool(name, properties)], undefined, (frame) => frames.push(frame), (exec) => execs.push(exec));
        expect(frames).toEqual([]);
        expect(execs).toHaveLength(1);
        expect(execs[0]!.toolName).toBe(name);
        expect(JSON.parse(execs[0]!.decodedArgs)).toEqual({ command: "echo hi", workdir: "/repo", timeout: 1000 });
        expect(execs[0]!.native?.resultType).toBe(kind === "shellArgs" ? "shellResult" : "shellStreamResult");
      });
    }
  }

  test("supplies description only when advertised", () => {
    const redirect = redirectNativeExec(request("shellArgs"), [tool("bash", { ...properties, description: { type: "string" } })]);
    expect(JSON.parse(redirect!.decodedArgs)).toEqual({ command: "echo hi", description: "Runs shell command" });
  });

  test("prefers bash when both tools can represent the command", () => {
    expect(redirectNativeExec(request("shellArgs"), [tool("shell", properties), tool("bash", properties)])!.toolName).toBe("bash");
  });

  test("uses shell when bash cannot represent the requested workdir", () => {
    const redirect = redirectNativeExec(request("shellStreamArgs", { workingDirectory: "/repo" }),
      [tool("bash", { command: {} }), tool("shell", properties)]);
    expect(redirect!.toolName).toBe("shell");
  });

  test("does not guess with absent, malformed, or unrelated schemas", () => {
    for (const definition of [
      create(McpToolDefinitionSchema, { name: "shell" }),
      create(McpToolDefinitionSchema, { name: "shell", inputSchema: new Uint8Array([255]) }),
      tool("shell", { script: {} }),
    ]) {
      expect(redirectNativeExec(request("shellStreamArgs"), [definition])).toBeNull();
    }
  });

  test.each([{ workingDirectory: "/repo" }, { timeout: 1000 }])("does not silently drop requested options %j", (args) => {
    expect(redirectNativeExec(request("shellStreamArgs", args), [tool("shell", { command: {} })])).toBeNull();
  });
});

describe("native shell wire responses", () => {
  for (const kind of ["shellArgs", "shellStreamArgs"] as const) {
    test(`rejects unavailable ${kind} with its matching response before closing`, () => {
      const frames: Uint8Array[] = [];
      const execs: PendingExec[] = [];
      handleExecMessage(request(kind), [], undefined, (frame) => frames.push(frame), (exec) => execs.push(exec));
      expect(execs).toEqual([]);
      expect(frames).toHaveLength(2);
      const [result, close] = frames.map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
      expect(result!.message.case).toBe("execClientMessage");
      if (result!.message.case !== "execClientMessage") throw new Error("missing exec response");
      expect(result!.message.value.id).toBe(42);
      expect(result!.message.value.execId).toBe("shell-exec");
      const message = result!.message.value.message;
      if (kind === "shellStreamArgs") {
        expect(message.case).toBe("shellStream");
        if (message.case !== "shellStream") throw new Error("wrong streaming response");
        expect(message.value.event.case).toBe("rejected");
        if (message.value.event.case !== "rejected") throw new Error("missing rejection");
        expect(message.value.event.value.reason).toContain("Use the MCP tools");
      } else {
        expect(message.case).toBe("shellResult");
        if (message.case !== "shellResult") throw new Error("wrong unary response");
        expect(message.value.result.case).toBe("rejected");
      }
      expect(close!.message.case).toBe("execClientControlMessage");
      if (close!.message.case !== "execClientControlMessage") throw new Error("missing stream close");
      expect(close!.message.value.message.case).toBe("streamClose");
      if (close!.message.value.message.case !== "streamClose") throw new Error("wrong control response");
      expect(close!.message.value.message.value.id).toBe(42);
    });
  }

  test("redirected successful shell streams contain a recognized exit event", () => {
    const redirect = redirectNativeExec(request("shellStreamArgs"), [tool("shell", properties)])!;
    const messages: Uint8Array[] = [];
    expect(sendNativeExecResult({ execId: "shell-exec", execMsgId: 42 }, redirect.binding, "hi\n", false,
      (bytes) => messages.push(bytes))).toBe(true);
    const events = messages.map((bytes) => {
      const message = fromBinary(AgentClientMessageSchema, bytes);
      if (message.message.case !== "execClientMessage" || message.message.value.message.case !== "shellStream") {
        throw new Error("Cursor would ignore this response");
      }
      return message.message.value.message.value.event;
    });
    expect(events.map((event) => event.case)).toEqual(["start", "stdout", "exit"]);
    if (events[2]!.case !== "exit") throw new Error("missing exit");
    expect(events[2]!.value.code).toBe(0);
  });
});
