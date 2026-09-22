import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  buildMcpStateExecClientMessage,
  describeUnknownExecFields,
  isMcpStateExecRequest,
} from "../src/proxy";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  McpToolDefinitionSchema,
} from "../src/proto/agent_pb";

function unwrapLengthDelimited(data: Uint8Array): Uint8Array {
  let length = 0;
  let shift = 0;
  let index = 0;
  for (;;) {
    const byte = data[index++];
    if (byte === undefined) throw new Error("truncated varint");
    length |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  expect(data.length - index).toBe(length);
  return data.subarray(index);
}

describe("mcp state exec compatibility", () => {
  test("answers Cursor's field-36 state request with the registered OpenCode tools", () => {
    // ExecServerMessage { id: 1, mcp_state_exec_args: { server_identifiers: "opencode" },
    // accept_hook_additional_contexts: true }. Both fields are newer than the
    // checked-in generated schema.
    const exec = fromBinary(ExecServerMessageSchema, new Uint8Array([
      0x08, 0x01, 0xa2, 0x02, 0x0a, 0x0a, 0x08,
      ...new TextEncoder().encode("opencode"), 0xb8, 0x03, 0x01,
    ]));
    expect(exec.message.case).toBeUndefined();
    expect(describeUnknownExecFields(exec.$unknown)).toEqual([
      { fieldNumber: 36, fieldName: "mcpStateExecArgs", wireType: 2, encodedBytes: 11 },
      { fieldNumber: 55, fieldName: "acceptHookAdditionalContexts", wireType: 0, encodedBytes: 1 },
    ]);
    expect(isMcpStateExecRequest(exec.$unknown)).toBe(true);

    const tool = create(McpToolDefinitionSchema, {
      name: "read",
      toolName: "read",
      providerIdentifier: "opencode",
    });
    const response = buildMcpStateExecClientMessage(exec, [tool]);
    const decoded = fromBinary(AgentClientMessageSchema, toBinary(AgentClientMessageSchema, response));
    expect(decoded.message.case).toBe("execClientMessage");
    if (decoded.message.case !== "execClientMessage") throw new Error("missing exec response");
    expect(decoded.message.value.id).toBe(1);

    const stateResult = decoded.message.value.$unknown?.find((field) => field.no === 36);
    expect(stateResult?.wireType).toBe(2);
    const resultBytes = unwrapLengthDelimited(stateResult!.data);
    expect(new TextDecoder().decode(resultBytes)).toContain("OpenCode");
    expect(new TextDecoder().decode(resultBytes)).toContain("opencode");
    expect(new TextDecoder().decode(resultBytes)).toContain("read");
  });
});
