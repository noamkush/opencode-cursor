/**
 * Steering: delivering a user message into a Cursor run that is already
 * working, the way Cursor's own client does.
 *
 * Without this, a message sent while tool calls are paused could only travel
 * inside a tool result, where the model reads it as untrusted tool output and
 * often ignores it as a prompt injection. An `InjectContextAction` instead
 * reaches the model as a real user message at the next step boundary.
 */
import { create, type UnknownField } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  AgentClientMessageSchema,
  ConversationActionSchema,
  type AgentClientMessage,
} from "./proto/agent_pb";
import {
  CONVERSATION_ACTION_INJECT_CONTEXT_FIELD,
  INTERACTION_UPDATE_CONTEXT_INJECTION_STATE_FIELD,
  unknownMessageBytes,
  unknownMessageField,
} from "./unknown-fields";

/** `ContextInjectionState` oneof cases, by field number. */
export type InjectionState = "queued" | "delivered" | "queued_for_next_turn" | "cancelled" | "rejected";

const INJECTION_STATES: Record<number, InjectionState> = {
  1: "queued",
  2: "delivered",
  3: "queued_for_next_turn",
  4: "cancelled",
  5: "rejected",
};

export interface InjectionStateUpdate {
  injectionId: string;
  state: InjectionState;
  /** `ContextInjectionRejected.reason`, when rejected. */
  reason?: string;
}

/**
 * Only "queued" and "delivered" mean the server will show the message to the
 * model this turn; Cursor's client re-sends anything else as a follow-up.
 */
export function injectionAccepted(state: InjectionState): boolean {
  return state === "queued" || state === "delivered";
}

/**
 * An `AgentClientMessage` carrying `ConversationAction.inject_context_action`
 * with a `user_context` payload. `userMessage` and `requestContext` are the
 * serialized `UserMessage` and `RequestContext`.
 */
export function buildInjectContextMessage(input: {
  injectionId: string;
  runId: string;
  userMessage: Uint8Array;
  requestContext?: Uint8Array;
}): AgentClientMessage {
  const userContext = new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(input.userMessage);
  if (input.requestContext) userContext.tag(2, WireType.LengthDelimited).bytes(input.requestContext);
  const injectContext = new BinaryWriter()
    .tag(1, WireType.LengthDelimited).string(input.injectionId)
    .tag(2, WireType.LengthDelimited).string(input.runId)
    .tag(3, WireType.LengthDelimited).bytes(userContext.finish())
    .finish();
  const action = create(ConversationActionSchema, {});
  action.$unknown = [unknownMessageField(CONVERSATION_ACTION_INJECT_CONTEXT_FIELD, injectContext)];
  return create(AgentClientMessageSchema, {
    message: { case: "conversationAction", value: action },
  });
}

/** Decode `InteractionUpdate.context_injection_state` from an update's unknown fields. */
export function readInjectionStateUpdate(
  fields: readonly UnknownField[] | undefined,
): InjectionStateUpdate | undefined {
  const field = fields?.find(
    (f) => f.no === INTERACTION_UPDATE_CONTEXT_INJECTION_STATE_FIELD && f.wireType === WireType.LengthDelimited,
  );
  const bytes = field && unknownMessageBytes(field);
  if (!bytes) return undefined;
  try {
    let injectionId = "";
    let stateUpdate: Omit<InjectionStateUpdate, "injectionId"> | undefined;
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
      const [no, wireType] = reader.tag();
      if (no === 1 && wireType === WireType.LengthDelimited) injectionId = reader.string();
      else if (no === 2 && wireType === WireType.LengthDelimited) stateUpdate = readInjectionState(reader.bytes());
      else reader.skip(wireType);
    }
    return injectionId && stateUpdate ? { injectionId, ...stateUpdate } : undefined;
  } catch {
    return undefined;
  }
}

function readInjectionState(bytes: Uint8Array): Omit<InjectionStateUpdate, "injectionId"> | undefined {
  let result: Omit<InjectionStateUpdate, "injectionId"> | undefined;
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    const state = INJECTION_STATES[no];
    if (!state || wireType !== WireType.LengthDelimited) {
      reader.skip(wireType);
      continue;
    }
    const value = reader.bytes();
    result = { state, reason: state === "rejected" ? readReason(value) : undefined };
  }
  return result;
}

function readReason(bytes: Uint8Array): string | undefined {
  const reader = new BinaryReader(bytes);
  let reason: string | undefined;
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (no === 1 && wireType === WireType.LengthDelimited) reason = reader.string();
    else reader.skip(wireType);
  }
  return reason;
}

const waiting = new Map<string, (update: InjectionStateUpdate) => void>();

/**
 * Resolves with the first state the server reports for `injectionId`, or
 * `undefined` after `timeoutMs` without one.
 */
export function awaitInjectionState(
  injectionId: string,
  timeoutMs: number,
): Promise<InjectionStateUpdate | undefined> {
  const { promise, resolve } = Promise.withResolvers<InjectionStateUpdate | undefined>();
  const timer = setTimeout(() => {
    waiting.delete(injectionId);
    resolve(undefined);
  }, timeoutMs);
  waiting.set(injectionId, (update) => {
    clearTimeout(timer);
    waiting.delete(injectionId);
    resolve(update);
  });
  return promise;
}

/** Hand a state update to whoever awaits it. Returns false when nobody does. */
export function settleInjectionState(update: InjectionStateUpdate): boolean {
  const settle = waiting.get(update.injectionId);
  if (!settle) return false;
  settle(update);
  return true;
}
