import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { describeUnknownExecFields } from "../src/proxy";
import { ExecServerMessageSchema } from "../src/proto/agent_pb";

describe("unknown Cursor exec diagnostics", () => {
  test("identifies an unrecognized length-delimited exec field without its payload", () => {
    // ExecServerMessage { id: 1, shell_allowlist_precheck_args: {} }.
    // Field 41 is unknown to the checked-in generated schema.
    const exec = fromBinary(ExecServerMessageSchema, new Uint8Array([
      0x08, 0x01, 0xca, 0x02, 0x00,
    ]));

    expect(exec.message.case).toBeUndefined();
    expect(describeUnknownExecFields(exec.$unknown)).toEqual([
      { fieldNumber: 41, wireType: 2, encodedBytes: 1 },
    ]);
  });
});
