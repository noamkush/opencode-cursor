import { describe, expect, test } from "bun:test";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  bindReadOutput,
  redirectNativeExec,
  sendNativeExecResult,
  type NativeExecBinding,
} from "../src/native-tools";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
} from "../src/proto/agent_pb";

const file = "/project/big.txt";
const FILE_LINES = 5000;

/** ReadArgs with the offset (4) and limit (5) fields the checked-in schema lacks. */
function readExec(path: string, range: { offset?: number; limit?: number } = {}) {
  const writer = new BinaryWriter().tag(1, WireType.LengthDelimited).string(path);
  if (range.offset !== undefined) writer.tag(4, WireType.Varint).int32(range.offset);
  if (range.limit !== undefined) writer.tag(5, WireType.Varint).uint32(range.limit);
  return create(ExecServerMessageSchema, {
    id: 1,
    execId: "exec",
    message: { case: "readArgs", value: fromBinary(ReadArgsSchema, writer.finish()) },
  });
}

function redirect(path: string, range?: { offset?: number; limit?: number }) {
  const tools = [create(McpToolDefinitionSchema, {
    name: "read", toolName: "read",
    inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["filePath"] })),
  })];
  const result = redirectNativeExec(readExec(path, range), tools);
  expect(result).not.toBeNull();
  return { args: JSON.parse(result!.decodedArgs), binding: result!.binding };
}

function openCodeOutput(path: string, first: number, lines: readonly string[], footer: string) {
  return [
    `<path>${path}</path>`,
    "<type>file</type>",
    "<content>",
    ...lines.map((line, index) => `${first + index}: ${line}`),
    "",
    footer,
    "</content>",
  ].join("\n");
}

function sendRead(binding: NativeExecBinding, text: string) {
  const messages: Uint8Array[] = [];
  sendNativeExecResult({ execId: "exec", execMsgId: 1 }, binding, text, false, (bytes) => messages.push(bytes));
  const message = fromBinary(AgentClientMessageSchema, messages[0]!);
  if (message.message.case !== "execClientMessage") throw new Error("missing exec result");
  const result = message.message.value.message;
  if (result.case !== "readResult" || result.value.result.case !== "success") throw new Error("missing read success");
  return result.value.result.value;
}

describe("native read ranges", () => {
  test("forwards Cursor's offset and limit to OpenCode", () => {
    const { args, binding } = redirect(file, { offset: 2001, limit: 100 });
    expect(args).toEqual({ filePath: file, offset: 2001, limit: 100 });
    expect(binding.args).toEqual({ path: file, offset: "2001", limit: "100" });
  });

  test("sends no range when Cursor asks for the whole file", () => {
    const { args, binding } = redirect(file);
    expect(args).toEqual({ filePath: file });
    expect(binding.args).toEqual({ path: file });
  });

  test("forwards ranges to V2 only when the schema supports them", () => {
    const tools = [create(McpToolDefinitionSchema, {
      name: "read", toolName: "read",
      inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } })),
    })];
    expect(JSON.parse(redirectNativeExec(readExec(file, { offset: 101, limit: 150 }), tools)!.decodedArgs)).toEqual({ path: file, offset: 101, limit: 150 });
    tools[0]!.inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties: { path: { type: "string" } } }));
    expect(redirectNativeExec(readExec(file, { offset: 101, limit: 150 }), tools)).toBeNull();
  });

  test("rejects negative offsets without opening local files", () => {
    const tools = [create(McpToolDefinitionSchema, {
      name: "read", toolName: "read",
      inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties: { path: { type: "string" } } })),
    })];
    expect(redirectNativeExec(readExec(file, { offset: -3 }), tools)).toBeNull();
    expect(redirectNativeExec(readExec("relative.txt", { offset: -10, limit: 2 }), tools)).toBeNull();
  });
});

describe("native read results", () => {
  test("reports the file's total from a partial-read footer", () => {
    const { binding } = redirect(file);
    const output = openCodeOutput(file, 1, ["line 1", "line 2"], "(Showing lines 1-2000 of 5000. Use offset=2001 to continue.)");
    const success = sendRead(bindReadOutput(binding, output), "line 1\nline 2");
    expect(success.totalLines).toBe(FILE_LINES);
    expect(success.truncated).toBe(true);
    expect(success.$unknown ?? []).toEqual([]);
  });

  test("reports a lower bound when OpenCode caps output by size", () => {
    const { binding } = redirect(file);
    const output = openCodeOutput(file, 1, ["line 1"], "(Output capped at 50 KB. Showing lines 1-960. Use offset=961 to continue.)");
    const bound = bindReadOutput(binding, output);
    expect(bound.args.totalLines).toBe("961");
    expect(bound.args.fileSize).toBe("0");
    expect(bound.args.truncated).toBe("true");
  });

  test("does not report truncation when the requested range was served", () => {
    const { binding } = redirect(file, { offset: 2001, limit: 2 });
    const output = openCodeOutput(file, 2001, ["line 2001", "line 2002"], "(Showing lines 2001-2002 of 5000. Use offset=2003 to continue.)");
    const success = sendRead(bindReadOutput(binding, output), "line 2001\nline 2002");
    expect(success.totalLines).toBe(FILE_LINES);
    expect(success.truncated).toBe(false);
    expect(success.output).toEqual({ case: "content", value: "line 2001\nline 2002" });
  });

  test("marks the range as applied on the wire", () => {
    const { binding } = redirect(file, { offset: 4999 });
    const output = openCodeOutput(file, 4999, ["line 4999", "line 5000"], "(End of file - total 5000 lines)");
    const success = sendRead(bindReadOutput(binding, output), "line 4999\nline 5000");
    expect(success.totalLines).toBe(FILE_LINES);
    expect(success.truncated).toBe(false);
    // ReadSuccess.range_applied (field 8) = true.
    expect(success.$unknown).toEqual([{ no: 8, wireType: WireType.Varint, data: new Uint8Array([1]) }]);
  });

  test("reports lines OpenCode shortened as truncated", () => {
    const { binding } = redirect(file);
    const output = openCodeOutput(file, 1, ["x... (line truncated to 2000 chars)"], "(End of file - total 1 lines)");
    expect(bindReadOutput(binding, output).args.truncated).toBe("true");
  });

  test("leaves non-envelope output to the text-based fallback", () => {
    const binding: NativeExecBinding = { resultType: "readResult", args: { path: file } };
    expect(bindReadOutput(binding, "plain text")).toBe(binding);
    const success = sendRead(binding, "a\nb");
    expect(success.totalLines).toBe(2);
    expect(success.truncated).toBe(false);
    expect(sendRead({ resultType: "readResult", args: { path: file, offset: "101" } }, "a\nb").totalLines).toBe(102);
  });
});
