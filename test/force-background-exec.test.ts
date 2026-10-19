import { describe, expect, test } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  buildForceBackgroundNotFoundClientMessage,
  describeUnknownExecFields,
  forceBackgroundExecField,
  handleExecMessage,
} from "../src/proxy";
import { AgentClientMessageSchema, ExecServerMessageSchema } from "../src/proto/agent_pb";

/** ExecServerMessage { id, exec_id, <field> { tool_call_id }, accept_hook_additional_contexts: true } */
function forceBackgroundExec(field: number, id: number) {
  const args = new BinaryWriter().tag(1, WireType.LengthDelimited).string("call_abc").finish();
  return fromBinary(ExecServerMessageSchema, new BinaryWriter()
    .tag(1, WireType.Varint).uint32(id)
    .tag(15, WireType.LengthDelimited).string("exec-1")
    .tag(field, WireType.LengthDelimited).bytes(args)
    .tag(55, WireType.Varint).bool(true)
    .finish());
}

/** Unwrap a Connect frame (5-byte header) into an AgentClientMessage. */
function decodeFrame(frame: Uint8Array) {
  return fromBinary(AgentClientMessageSchema, frame.subarray(5));
}

describe("force background exec compatibility", () => {
  for (const [field, fieldName] of [[30, "forceBackgroundShellArgs"], [31, "forceBackgroundSubagentArgs"]] as const) {
    test(`answers field-${field} ${fieldName} with NOT_FOUND`, () => {
      const exec = forceBackgroundExec(field, 12);
      expect(exec.message.case).toBeUndefined();
      expect(describeUnknownExecFields(exec.$unknown)[0]).toMatchObject({ fieldNumber: field, fieldName });
      expect(forceBackgroundExecField(exec.$unknown)).toBe(field);

      const response = buildForceBackgroundNotFoundClientMessage(exec, field);
      const decoded = fromBinary(AgentClientMessageSchema, toBinary(AgentClientMessageSchema, response));
      if (decoded.message.case !== "execClientMessage") throw new Error("missing exec response");
      expect(decoded.message.value.id).toBe(12);
      expect(decoded.message.value.execId).toBe("exec-1");
      const result = decoded.message.value.$unknown?.find((f) => f.no === field);
      expect(result?.wireType).toBe(WireType.LengthDelimited);
      // length 2, then field 1 varint = 2 (NOT_FOUND)
      expect([...result!.data]).toEqual([0x02, 0x08, 0x02]);
    });
  }

  test("does not fail the stream", () => {
    const frames: Uint8Array[] = [];
    let unhandled: string | undefined;
    handleExecMessage(
      forceBackgroundExec(30, 7),
      [],
      undefined,
      (data) => frames.push(data),
      () => { throw new Error("unexpected MCP exec"); },
      (execCase) => { unhandled = execCase; },
    );
    expect(unhandled).toBeUndefined();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = decodeFrame(frames[0]!);
    if (first.message.case !== "execClientMessage") throw new Error("missing exec response");
    expect(first.message.value.$unknown?.some((f) => f.no === 30)).toBe(true);
  });

  test("ignores exec messages without either field", () => {
    expect(forceBackgroundExecField(forceBackgroundExec(36, 1).$unknown)).toBeUndefined();
  });
});
