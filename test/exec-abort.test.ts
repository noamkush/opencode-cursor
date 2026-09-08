import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { abortPendingExec, type PendingExec } from "../src/proxy";
import { AgentClientMessageSchema } from "../src/proto/agent_pb";

function decodeFrame(frame: Uint8Array) {
  const bytes = frame.subarray(5);
  return fromBinary(AgentClientMessageSchema, bytes);
}

describe("abortPendingExec", () => {
  test("fails and closes a pending MCP exec", () => {
    const execs: PendingExec[] = [{
      execId: "exec-1",
      execMsgId: 12,
      toolCallId: "tool-1",
      toolName: "read",
      decodedArgs: "{}",
    }];
    const frames: Uint8Array[] = [];

    expect(abortPendingExec(execs, 12, (frame) => frames.push(frame))).toBe(true);
    expect(execs).toHaveLength(0);
    expect(frames).toHaveLength(2);

    const result = decodeFrame(frames[0]!);
    expect(result.message.case).toBe("execClientMessage");
    if (result.message.case !== "execClientMessage") return;
    expect(result.message.value.message.case).toBe("mcpResult");
    if (result.message.value.message.case !== "mcpResult") return;
    expect(result.message.value.message.value.result.case).toBe("error");

    const close = decodeFrame(frames[1]!);
    expect(close.message.case).toBe("execClientControlMessage");
    if (close.message.case === "execClientControlMessage") {
      expect(close.message.value.message.case).toBe("streamClose");
    }
  });

  test("uses a typed failure for redirected native execs", () => {
    const execs: PendingExec[] = [{
      execId: "exec-2",
      execMsgId: 13,
      toolCallId: "tool-2",
      toolName: "bash",
      decodedArgs: "{}",
      native: { resultType: "shellResult", args: { command: "sleep 10" } },
    }];
    const frames: Uint8Array[] = [];

    expect(abortPendingExec(execs, 13, (frame) => frames.push(frame))).toBe(true);
    const result = decodeFrame(frames[0]!);
    if (result.message.case !== "execClientMessage") throw new Error("missing exec result");
    expect(result.message.value.message.case).toBe("shellResult");
    if (result.message.value.message.case === "shellResult") {
      expect(result.message.value.message.value.result.case).toBe("failure");
    }
  });

  test("ignores unknown and repeated abort IDs", () => {
    const execs: PendingExec[] = [{
      execId: "exec-3",
      execMsgId: 14,
      toolCallId: "tool-3",
      toolName: "grep",
      decodedArgs: "{}",
    }];
    const frames: Uint8Array[] = [];

    expect(abortPendingExec(execs, 99, (frame) => frames.push(frame))).toBe(false);
    expect(abortPendingExec(execs, 14, (frame) => frames.push(frame))).toBe(true);
    expect(abortPendingExec(execs, 14, (frame) => frames.push(frame))).toBe(false);
    expect(frames).toHaveLength(2);
  });
});
