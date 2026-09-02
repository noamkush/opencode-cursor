import { describe, expect, test } from "bun:test";
import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { filePathKey, normalizeToolArgs, redirectNativeExec } from "../src/native-tools";
import { handleExecMessage, type PendingExec } from "../src/proxy";
import { ExecServerMessageSchema, McpArgsSchema, McpToolDefinitionSchema, ReadArgsSchema, WriteArgsSchema } from "../src/proto/agent_pb";

function tool(name: string, properties: Record<string, unknown>) {
  return create(McpToolDefinitionSchema, {
    name, toolName: name,
    inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties })),
  });
}

describe("schema-aware path arguments", () => {
  for (const key of ["path", "filePath"] as const) {
    test(`routes native reads and writes to ${key}`, () => {
      const read = create(ExecServerMessageSchema, { message: { case: "readArgs", value: create(ReadArgsSchema, { path: "src/a.ts" }) } });
      expect(JSON.parse(redirectNativeExec(read, [tool("read", { [key]: { type: "string" } })])!.decodedArgs)).toEqual({ [key]: "src/a.ts" });
      const content = "1: literal\n2: content\n";
      const write = create(ExecServerMessageSchema, { message: { case: "writeArgs", value: create(WriteArgsSchema, { path: "src/a.ts", fileText: content }) } });
      expect(JSON.parse(redirectNativeExec(write, [tool("write", { [key]: { type: "string" }, content: { type: "string" } })])!.decodedArgs)).toEqual({ [key]: "src/a.ts", content });
    });

    test(`routes MCP aliases to ${key} while keeping limits`, () => {
      const alias = key === "path" ? "filePath" : "path";
      const execs: PendingExec[] = [];
      handleExecMessage(create(ExecServerMessageSchema, { message: { case: "mcpArgs", value: create(McpArgsSchema, {
        toolName: "read", args: {
          [alias]: toBinary(ValueSchema, fromJson(ValueSchema, "src/a.ts")),
          limit: toBinary(ValueSchema, fromJson(ValueSchema, 150)),
        },
      }) } }), [tool("read", { [key]: { type: "string" }, limit: { type: "number" } })], undefined, () => {}, (exec) => execs.push(exec));
      expect(JSON.parse(execs[0]!.decodedArgs)).toEqual({ [key]: "src/a.ts", limit: 150 });
    });

    test(`${key} wins over aliases and normalization is idempotent`, () => {
      const tools = [tool("read", { [key]: { type: "string" } })];
      const input = { path: "path.ts", filePath: "filePath.ts", filepath: "lowercase.ts", limit: 150 };
      const output = normalizeToolArgs("read", input, tools);
      expect(output).toEqual({ [key]: input[key], limit: 150 });
      expect(normalizeToolArgs("read", output, tools)).toEqual(output);
      expect(input).toHaveProperty("filepath", "lowercase.ts");
    });

    test(`normalizes lowercase filepath to ${key}`, () => {
      expect(normalizeToolArgs("read", { filepath: "a.ts" }, [tool("read", { [key]: {} })])).toEqual({ [key]: "a.ts" });
    });
  }

  test("does not guess when a schema is absent, malformed or ambiguous", () => {
    const absent = create(McpToolDefinitionSchema, { name: "read" });
    const malformed = create(McpToolDefinitionSchema, { name: "read", inputSchema: new Uint8Array([255]) });
    const ambiguous = tool("read", { path: {}, filePath: {} });
    for (const definition of [absent, malformed, ambiguous]) {
      expect(filePathKey(definition)).toBeUndefined();
      const args = { path: "keep.ts", limit: 150 };
      expect(normalizeToolArgs("read", args, [definition])).toBe(args);
      const exec = create(ExecServerMessageSchema, { message: { case: "readArgs", value: create(ReadArgsSchema, { path: "keep.ts" }) } });
      expect(redirectNativeExec(exec, [definition])).toBeNull();
    }
  });

  test("does not rename fields advertised by custom edit/glob tools", () => {
    const edit = { path: "a", old_string: "1: old", new_string: "2: new" };
    expect(normalizeToolArgs("edit", edit, [tool("edit", { path: {}, old_string: {}, new_string: {} })])).toEqual(edit);
    const glob = { globPattern: "*.ts", target_directory: "." };
    expect(normalizeToolArgs("glob", glob, [tool("glob", { globPattern: {}, target_directory: {} })])).toEqual(glob);
    expect(normalizeToolArgs("read", { path: "a", filepath: "custom" }, [tool("read", { path: {}, filepath: {} })])).toEqual({ path: "a", filepath: "custom" });
  });

  test("preserves the reported V2 MCP path and limit without mutation", () => {
    const execs: PendingExec[] = [];
    handleExecMessage(create(ExecServerMessageSchema, { message: { case: "mcpArgs", value: create(McpArgsSchema, {
      toolName: "read", args: {
        path: toBinary(ValueSchema, fromJson(ValueSchema, "src/a.ts")),
        limit: toBinary(ValueSchema, fromJson(ValueSchema, 150)),
      },
    }) } }), [tool("read", { path: { type: "string" }, limit: { type: "number" } })], undefined, () => {}, (exec) => execs.push(exec));
    expect(JSON.parse(execs[0]!.decodedArgs)).toEqual({ path: "src/a.ts", limit: 150 });
  });
});

describe("schema-aware glob and edit aliases", () => {
  test.each([
    [{ globPattern: "**/*.ts" }, { pattern: "**/*.ts" }],
    [{ glob_pattern: "src/**/*.ts", target_directory: "/tmp" }, { pattern: "src/**/*.ts", path: "/tmp" }],
    [{ globPattern: "*.ts", targetDirectory: "/tmp" }, { pattern: "*.ts", path: "/tmp" }],
    [{ pattern: "**/*.ts", path: "." }, { pattern: "**/*.ts", path: "." }],
    [{ pattern: "keep", globPattern: "drop", path: ".", target_directory: "/drop" }, { pattern: "keep", path: "." }],
  ])("normalizes glob aliases %j", (input, expected) => {
    expect(normalizeToolArgs("glob", input, [tool("glob", { pattern: {}, path: {} })])).toEqual(expected);
  });

  test("normalizes edit aliases including replace_all", () => {
    expect(normalizeToolArgs("edit", { filePath: "a.ts", old_string: "before", new_string: "after", replace_all: true }, [tool("edit", { filePath: {}, oldString: {}, newString: {}, replaceAll: {} })])).toEqual({ filePath: "a.ts", oldString: "before", newString: "after", replaceAll: true });
  });

  test("canonical edit values win, including false and empty strings", () => {
    expect(normalizeToolArgs("edit", { oldString: "", old_string: "drop", newString: "keep", new_string: "drop", replaceAll: false, replace_all: true }, [tool("edit", { oldString: {}, newString: {}, replaceAll: {} })])).toEqual({ oldString: "", newString: "keep", replaceAll: false });
  });
});

describe("literal mutation content", () => {
  test.each(["plain text", "1: first\n2: second\n", "  1|first\n  2|second", "<path>a</path>\n<type>file</type>\n<content>\n1: literal\n\n(End of file - total 1 lines)\n</content>"])("preserves %s", (content) => {
    expect(normalizeToolArgs("write", { path: "a", content }, [tool("write", { path: {}, content: {} })])).toEqual({ path: "a", content });
    expect(normalizeToolArgs("edit", { path: "a", old_string: content, new_string: content }, [tool("edit", { path: {}, oldString: {}, newString: {} })])).toEqual({ path: "a", oldString: content, newString: content });
    const native = create(ExecServerMessageSchema, { message: { case: "writeArgs", value: create(WriteArgsSchema, { path: "a", fileText: content }) } });
    expect(JSON.parse(redirectNativeExec(native, [tool("write", { path: {}, content: {} })])!.decodedArgs)).toEqual({ path: "a", content });
  });
});
