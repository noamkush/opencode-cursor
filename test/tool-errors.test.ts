import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { LanguageModel, LLMRequest, Message } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat";
import { OpenAICompatibleChat } from "@opencode/ai/protocols/openai-compatible-chat";
import { Effect } from "effect";
import { collectToolErrorIds, decodeToolErrorIds, markToolErrors, toolErrorText } from "../src/tool-errors";
import { parseMessages } from "../src/proxy";
import { sendNativeExecResult } from "../src/native-tools";
import { AgentClientMessageSchema } from "../src/proto/agent_pb";

describe("serialized tool failures", () => {
  test("carries real OpenCode error results through OpenAI serialization into native errors", async () => {
    const messages = [new Message({ role: "tool", content: [
      { type: "tool-result", id: "failed", name: "read", result: { type: "error", value: "Permission denied" } },
      { type: "tool-result", id: "success", name: "read", result: { type: "text", value: "Permission denied" } },
    ] })];
    const body = await Effect.runPromise(OpenAIChat.fromRequest(new LLMRequest({
      model: LanguageModel.make({ id: "test", provider: "cursor", route: OpenAICompatibleChat.route }),
      system: [], messages, tools: [],
    })));
    expect(body.messages[0]).not.toHaveProperty("is_error");
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const marked = await markToolErrors(request, collectToolErrorIds(messages));
    const serialized = await marked.json();
    expect(serialized.messages[0].is_error).toBe(true);
    expect(serialized.messages[1]).not.toHaveProperty("is_error");
    expect(serialized.messages[0].content).toBe("Permission denied");
    const { toolResults } = parseMessages(serialized.messages);
    expect(toolResults.map((result) => result.isError)).toEqual([true, false]);
    const frames: Uint8Array[] = [];
    sendNativeExecResult({ execId: "exec", execMsgId: 1 }, { resultType: "readResult", args: { path: "a" } }, toolResults[0]!.content, toolResults[0]!.isError, (bytes) => frames.push(bytes));
    const message = fromBinary(AgentClientMessageSchema, frames[0]!);
    if (message.message.case !== "execClientMessage" || message.message.value.message.case !== "readResult") throw new Error("Missing native read result");
    expect(message.message.value.message.value.result.case).toBe("error");
    // Reading a clone must not consume the original request body.
    expect(await request.json()).toEqual(body);
  });

  test("handles explicit legacy markers without guessing from text", () => {
    expect(decodeToolErrorIds('["a",2,null,"b"]')).toEqual(new Set(["a", "b"]));
    expect(decodeToolErrorIds("invalid")).toEqual(new Set());
    expect(decodeToolErrorIds(null)).toEqual(new Set());
    expect(parseMessages([
      { role: "tool", content: "Error: literal file content", tool_call_id: "a" },
      { role: "tool", content: "failed", tool_call_id: "b", isError: true },
    ]).toolResults.map((result) => result.isError)).toEqual([false, true]);
  });

  test("leaves unrelated requests and unknown tool calls unchanged", async () => {
    for (const [url, body] of [
      ["http://localhost/v1/models", '{"messages":[]}'],
      ["http://localhost/v1/chat/completions", '{"messages":[{"role":"tool","tool_call_id":"other","content":"error"}]}'],
      ["http://localhost/v1/chat/completions", "invalid"],
    ]) {
      const request = new Request(url!, { method: "POST", body });
      expect(await markToolErrors(request, new Set(["failed"]))).toBe(request);
    }
  });
});

function nativeReadResult(text: string) {
  const frames: Uint8Array[] = [];
  sendNativeExecResult({ execId: "exec", execMsgId: 1 }, { resultType: "readResult", args: { path: "a.ts" } }, text, true, (bytes) => frames.push(bytes));
  const message = fromBinary(AgentClientMessageSchema, frames[0]!);
  if (message.message.case !== "execClientMessage" || message.message.value.message.case !== "readResult") throw new Error("Missing native read result");
  return message.message.value.message.value.result;
}

describe("tool failure text", () => {
  test("reports OpenCode's serialized missing-file failure as fileNotFound", async () => {
    const failure = { error: { type: "tool.execution", message: "File not found: a.ts\n\nDid you mean one of these?\nA.ts" }, content: [] };
    const body = await Effect.runPromise(OpenAIChat.fromRequest(new LLMRequest({
      model: LanguageModel.make({ id: "test", provider: "cursor", route: OpenAICompatibleChat.route }),
      system: [], tools: [],
      messages: [new Message({ role: "tool", content: [{ type: "tool-result", id: "read", name: "read", result: { type: "error", value: failure } }] })],
    })));
    const text = toolErrorText(body.messages[0].content);
    expect(text).toBe(failure.error.message);
    const result = nativeReadResult(text);
    expect(result.case).toBe("fileNotFound");
    expect(result.value).toMatchObject({ path: "a.ts" });
  });

  test("keeps other read failures as errors", () => {
    const result = nativeReadResult("Cannot read binary file: a.bin");
    expect(result.case).toBe("error");
    expect(result.value).toMatchObject({ error: "Cannot read binary file: a.bin" });
  });

  test("keeps partial text output alongside the message", () => {
    expect(toolErrorText(JSON.stringify({ error: { type: "tool.execution", message: "Command failed" }, content: [{ type: "text", text: "partial" }, { type: "file", uri: "x" }] })))
      .toBe("Command failed\n\npartial");
  });

  test("leaves text that is not an OpenCode failure envelope unchanged", () => {
    for (const text of ["Permission denied", '{"error":"plain"}', '{"message":"x"}', "[1]", "{broken"]) {
      expect(toolErrorText(text)).toBe(text);
    }
  });
});
