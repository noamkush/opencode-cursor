import { describe, expect, test } from "bun:test";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { buildGrepResult, redirectNativeExec } from "../src/native-tools";
import { handleExecMessage } from "../src/proxy";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  GrepArgsSchema,
  LsArgsSchema,
  McpToolDefinitionSchema,
  RequestContextArgsSchema,
} from "../src/proto/agent_pb";
import { REQUEST_CONTEXT_ENV_PROCESS_WORKING_DIRECTORY_FIELD } from "../src/unknown-fields";
import {
  buildRequestContextEnv,
  decodeWorkspaceDirectory,
  encodeWorkspaceDirectory,
} from "../src/workspace";

function tool(name: string, properties: Record<string, unknown>) {
  return create(McpToolDefinitionSchema, {
    name, toolName: name,
    inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, { type: "object", properties })),
  });
}

const tools = [tool("glob", { pattern: {}, path: {} }), tool("grep", { pattern: {}, path: {}, include: {} })];

describe("workspace directory header", () => {
  test("round-trips non-ASCII directories", () => {
    expect(decodeWorkspaceDirectory(encodeWorkspaceDirectory("/home/u/プロジェクト"))).toBe("/home/u/プロジェクト");
  });

  test.each([null, "", "relative/dir", "%E0%A4%A"])("rejects %p", (value) => {
    expect(decodeWorkspaceDirectory(value)).toBeUndefined();
  });
});

describe("RequestContext env", () => {
  test("names the workspace and working directory", () => {
    const env = buildRequestContextEnv("/home/u/proj");
    expect(env.workspacePaths).toEqual(["/home/u/proj"]);
    expect(env.osVersion).not.toBe("");
    const field = env.$unknown?.find((f) => f.no === REQUEST_CONTEXT_ENV_PROCESS_WORKING_DIRECTORY_FIELD);
    expect(new BinaryReader(field!.data).string()).toBe("/home/u/proj");
  });

  test("omits workspace paths when the directory is unknown", () => {
    const env = buildRequestContextEnv(undefined);
    expect(env.workspacePaths).toEqual([]);
    expect(env.$unknown ?? []).toEqual([]);
  });

  test("is sent in the RequestContext result", () => {
    const frames: Uint8Array[] = [];
    handleExecMessage(
      create(ExecServerMessageSchema, {
        id: 1, execId: "ctx",
        message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
      }),
      [], { cloudRule: "rules", directory: "/home/u/proj" },
      (frame) => frames.push(frame), () => {},
    );
    // Connect frames carry a 5-byte header before the message.
    const message = fromBinary(AgentClientMessageSchema, frames[0]!.slice(5));
    if (message.message.case !== "execClientMessage") throw new Error("missing exec result");
    const result = message.message.value.message;
    if (result.case !== "requestContextResult" || result.value.result.case !== "success") throw new Error("missing context");
    const context = result.value.result.value.requestContext!;
    expect(context.cloudRule).toBe("rules");
    expect(context.env?.workspacePaths).toEqual(["/home/u/proj"]);
  });
});

describe("native search roots", () => {
  test.each(["", ".", "app", "/home/u/proj/app"])("resolves ls path %p against the workspace", (path) => {
    const exec = create(ExecServerMessageSchema, {
      message: { case: "lsArgs", value: create(LsArgsSchema, { path }) },
    });
    const binding = redirectNativeExec(exec, tools, "/home/u/proj")!.binding;
    expect(binding.args.path).toBe(path);
    expect(binding.args.root).toBe(path.includes("app") ? "/home/u/proj/app" : "/home/u/proj");
  });

  test("keys grep results by the absolute search root", () => {
    const exec = create(ExecServerMessageSchema, {
      message: { case: "grepArgs", value: create(GrepArgsSchema, { pattern: "x" }) },
    });
    const redirect = redirectNativeExec(exec, tools, "/home/u/proj")!;
    expect(JSON.parse(redirect.decodedArgs)).toEqual({ pattern: "x" });
    const result = buildGrepResult("No matches found", redirect.binding.args);
    if (result?.result.case !== "success") throw new Error("grep failed");
    expect(Object.keys(result.result.value.workspaceResults)).toEqual(["/home/u/proj"]);
    expect(result.result.value.path).toBe("");
  });

  test("leaves relative roots unresolved without a workspace", () => {
    const exec = create(ExecServerMessageSchema, {
      message: { case: "lsArgs", value: create(LsArgsSchema, { path: "app" }) },
    });
    expect(redirectNativeExec(exec, tools)!.binding.args.root).toBeUndefined();
  });
});
