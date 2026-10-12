import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  AgentClientMessageSchema,
  InteractionUpdateSchema,
  RequestContextSchema,
  UserMessageSchema,
} from "../src/proto/agent_pb";
import {
  awaitInjectionState,
  buildInjectContextMessage,
  injectionAccepted,
  readInjectionStateUpdate,
  settleInjectionState,
} from "../src/steering";
import { unknownMessageBytes } from "../src/unknown-fields";

function messageFields(bytes: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (wireType !== WireType.LengthDelimited) {
      reader.skip(wireType);
      continue;
    }
    fields.set(no, reader.bytes());
  }
  return fields;
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** InteractionUpdate { context_injection_state: { injection_id, state: { <stateField>: <stateBody> } } } */
function stateUpdate(injectionId: string, stateField: number, stateBody = new Uint8Array()) {
  const state = new BinaryWriter().tag(stateField, WireType.LengthDelimited).bytes(stateBody).finish();
  const update = new BinaryWriter()
    .tag(1, WireType.LengthDelimited).string(injectionId)
    .tag(2, WireType.LengthDelimited).bytes(state)
    .finish();
  const bytes = new BinaryWriter().tag(23, WireType.LengthDelimited).bytes(update).finish();
  return fromBinary(InteractionUpdateSchema, bytes);
}

describe("steering injection", () => {
  test("sends the user message as ConversationAction.inject_context_action", () => {
    const userMessage = toBinary(UserMessageSchema, create(UserMessageSchema, { text: "stop and use yarn", messageId: "inj-1" }));
    const requestContext = toBinary(RequestContextSchema, create(RequestContextSchema, { cloudRule: "be brief" }));
    const message = buildInjectContextMessage({ injectionId: "inj-1", runId: "run-1", userMessage, requestContext });

    const decoded = fromBinary(AgentClientMessageSchema, toBinary(AgentClientMessageSchema, message));
    if (decoded.message.case !== "conversationAction") throw new Error("expected a conversation action");
    const action = decoded.message.value;
    expect(action.action.case).toBeUndefined();
    const field = action.$unknown?.find((f) => f.no === 19);
    expect(field?.wireType).toBe(WireType.LengthDelimited);

    const inject = messageFields(unknownMessageBytes(field!)!);
    expect(text(inject.get(1))).toBe("inj-1");
    expect(text(inject.get(2))).toBe("run-1");
    const userContext = messageFields(inject.get(3)!);
    expect(fromBinary(UserMessageSchema, userContext.get(1)!).text).toBe("stop and use yarn");
    expect(fromBinary(RequestContextSchema, userContext.get(2)!).cloudRule).toBe("be brief");
  });

  test("reads context_injection_state updates", () => {
    const queued = stateUpdate("inj-1", 1);
    expect(queued.message.case).toBeUndefined();
    expect(readInjectionStateUpdate(queued.$unknown)).toEqual({ injectionId: "inj-1", state: "queued", reason: undefined });

    const reason = new BinaryWriter().tag(1, WireType.LengthDelimited).string("run ended").finish();
    expect(readInjectionStateUpdate(stateUpdate("inj-2", 5, reason).$unknown)).toEqual({
      injectionId: "inj-2",
      state: "rejected",
      reason: "run ended",
    });

    expect(readInjectionStateUpdate(create(InteractionUpdateSchema, {}).$unknown)).toBeUndefined();
  });

  test("only queued and delivered count as accepted", () => {
    expect(injectionAccepted("queued")).toBe(true);
    expect(injectionAccepted("delivered")).toBe(true);
    expect(injectionAccepted("queued_for_next_turn")).toBe(false);
    expect(injectionAccepted("cancelled")).toBe(false);
    expect(injectionAccepted("rejected")).toBe(false);
  });

  test("resolves the waiter with the first reported state, or undefined on timeout", async () => {
    const verdict = awaitInjectionState("inj-3", 1_000);
    expect(settleInjectionState({ injectionId: "inj-3", state: "delivered" })).toBe(true);
    expect(await verdict).toEqual({ injectionId: "inj-3", state: "delivered" });
    expect(settleInjectionState({ injectionId: "inj-3", state: "rejected" })).toBe(false);

    expect(await awaitInjectionState("inj-4", 10)).toBeUndefined();
    expect(settleInjectionState({ injectionId: "inj-4", state: "queued" })).toBe(false);
  });
});
