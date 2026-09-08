import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { buildUnavailableExecResult } from "../src/proxy";
import {
  ComputerUseArgsSchema,
  DiagnosticsArgsSchema,
  ExecServerMessageSchema,
  ListMcpResourcesExecArgsSchema,
  ReadMcpResourceExecArgsSchema,
  RecordScreenArgsSchema,
} from "../src/proto/agent_pb";

describe("unavailable exec results", () => {
  test.each([
    ["diagnosticsArgs", DiagnosticsArgsSchema, { path: "/repo/file.ts" }, "diagnosticsResult", "rejected"],
    ["listMcpResourcesExecArgs", ListMcpResourcesExecArgsSchema, {}, "listMcpResourcesExecResult", "rejected"],
    ["readMcpResourceExecArgs", ReadMcpResourceExecArgsSchema, { uri: "file:///resource" }, "readMcpResourceExecResult", "rejected"],
    ["recordScreenArgs", RecordScreenArgsSchema, {}, "recordScreenResult", "failure"],
    ["computerUseArgs", ComputerUseArgsSchema, {}, "computerUseResult", "error"],
  ] as const)("sets the %s result variant", (argsCase, schema, args, resultCase, expectedVariant) => {
    const exec = create(ExecServerMessageSchema, {
      id: 1,
      execId: "exec",
      message: { case: argsCase, value: create(schema, args) } as never,
    });

    const result = buildUnavailableExecResult(exec, "unavailable");
    expect(result?.messageCase).toBe(resultCase);
    expect((result?.value as { result: { case: string } }).result.case).toBe(expectedVariant);
  });
});
