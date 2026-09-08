import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { sendNativeExecResult, type NativeExecBinding } from "../src/native-tools";
import { AgentClientMessageSchema } from "../src/proto/agent_pb";

function resultCase(binding: NativeExecBinding, isError: boolean) {
  const messages: Uint8Array[] = [];
  const sent = sendNativeExecResult(
    { execId: "exec", execMsgId: 3 } as never,
    binding,
    isError ? "tool failed" : "tool output",
    isError,
    (bytes) => messages.push(bytes),
  );
  expect(sent).toBe(true);
  return messages.map((bytes) => {
    const message = fromBinary(AgentClientMessageSchema, bytes);
    expect(message.message.case).toBe("execClientMessage");
    if (message.message.case !== "execClientMessage") throw new Error("missing exec result");
    return message.message.value.message;
  });
}

describe("redirected native results", () => {
  test.each([
    ["readResult", "error"],
    ["writeResult", "error"],
    ["fetchResult", "error"],
    ["shellResult", "failure"],
    ["lsResult", "error"],
    ["grepResult", "error"],
  ] as const)("preserves errors for %s", (resultType, expectedCase) => {
    const [message] = resultCase({ resultType, args: {} }, true);
    expect(message!.case).toBe(resultType);
    expect((message!.value as { result: { case: string } }).result.case).toBe(expectedCase);
  });

  test("uses stderr and a non-zero exit for failed shell streams", () => {
    const messages = resultCase({ resultType: "shellStreamResult", args: {} }, true);
    expect(messages.map((message) => message.case)).toEqual([
      "shellStream",
      "shellStream",
      "shellStream",
    ]);
    expect((messages[1]!.value as { event: { case: string } }).event.case).toBe("stderr");
    expect((messages[2]!.value as { event: { value: { code: number } } }).event.value.code).toBe(1);
  });

  test("keeps successful shell results successful", () => {
    const [message] = resultCase({ resultType: "shellResult", args: {} }, false);
    expect((message!.value as { result: { case: string } }).result.case).toBe("success");
  });
});
