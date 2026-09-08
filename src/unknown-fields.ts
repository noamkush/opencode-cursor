/**
 * Protobuf fields newer than the checked-in Cursor schema.
 *
 * `src/proto/agent_pb.ts` was generated from Cursor's March 2026
 * `agent.proto`. Newer Cursor builds send and expect fields that schema does
 * not declare. protobuf-es keeps undeclared fields in a message's `$unknown`
 * list and writes them back out on serialization, so this module reads and
 * writes them there instead of regenerating the schema.
 *
 * Every field used this way has a constant below naming the message, the
 * upstream field name, and its wire type. When the schema is regenerated,
 * switch each call site to the generated field and delete its constant.
 */
import type { UnknownField } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

/**
 * `InteractionQuery.web_fetch_request_query` (query) and
 * `InteractionResponse.web_fetch_request_response` (response), both
 * length-delimited messages.
 */
export const INTERACTION_WEB_FETCH_FIELD = 9;

/** Find an unknown field by number and wire type. */
export function findUnknownField(
  fields: readonly UnknownField[] | undefined,
  no: number,
  wireType: WireType,
): UnknownField | undefined {
  return fields?.find((field) => field.no === no && field.wireType === wireType);
}

/** Encode `message` (already serialized) as a length-delimited unknown field. */
export function unknownMessageField(no: number, message: Uint8Array): UnknownField {
  return {
    no,
    wireType: WireType.LengthDelimited,
    data: new BinaryWriter().bytes(message).finish(),
  };
}
