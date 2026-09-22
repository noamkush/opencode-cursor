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
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

/**
 * `InteractionQuery.web_fetch_request_query` (query) and
 * `InteractionResponse.web_fetch_request_response` (response), both
 * length-delimited messages.
 */
export const INTERACTION_WEB_FETCH_FIELD = 9;

/**
 * `ExecServerMessage.mcp_state_exec_args` (request) and
 * `ExecClientMessage.mcp_state_exec_result` (response), both
 * length-delimited messages. Added in Cursor 2026.09.18.
 */
export const EXEC_MCP_STATE_FIELD = 36;

/**
 * `ExecServerMessage.accept_hook_additional_contexts`, a varint bool. Only
 * named in diagnostics; the proxy does not act on it.
 */
export const EXEC_ACCEPT_HOOK_ADDITIONAL_CONTEXTS_FIELD = 55;

/**
 * `RequestContext.mcp_meta_tool_options`, a length-delimited
 * `McpMetaToolOptions`. Current Cursor clients always send it; the agent
 * lists MCP servers from its descriptors.
 */
export const REQUEST_CONTEXT_MCP_META_TOOL_OPTIONS_FIELD = 34;

/** `RequestContext.mcp_info_complete`, a varint bool. */
export const REQUEST_CONTEXT_MCP_INFO_COMPLETE_FIELD = 36;

/** `McpArgs.server_identifier`, a string naming the tool's MCP server. */
export const MCP_ARGS_SERVER_IDENTIFIER_FIELD = 9;

/**
 * `ReadArgs.offset`, an optional varint int32. 1-based start line; a
 * negative value counts back from the end of the file.
 */
export const READ_ARGS_OFFSET_FIELD = 4;

/** `ReadArgs.limit`, an optional varint uint32 line count. */
export const READ_ARGS_LIMIT_FIELD = 5;

/**
 * `ReadSuccess.range_applied`, a varint bool. When false, Cursor applies the
 * requested offset and limit to the returned content itself, so it must be
 * true whenever the client already returned only the requested range.
 */
export const READ_SUCCESS_RANGE_APPLIED_FIELD = 8;

/** Find an unknown field by number and wire type. */
export function findUnknownField(
  fields: readonly UnknownField[] | undefined,
  no: number,
  wireType: WireType,
): UnknownField | undefined {
  return fields?.find((field) => field.no === no && field.wireType === wireType);
}

/** Read a varint int32 field. The last occurrence wins, as for any proto scalar. */
export function readUnknownInt32(
  fields: readonly UnknownField[] | undefined,
  no: number,
): number | undefined {
  return readLastVarint(fields, no, (reader) => reader.int32());
}

/** Read a varint uint32 field. The last occurrence wins, as for any proto scalar. */
export function readUnknownUint32(
  fields: readonly UnknownField[] | undefined,
  no: number,
): number | undefined {
  return readLastVarint(fields, no, (reader) => reader.uint32());
}

function readLastVarint(
  fields: readonly UnknownField[] | undefined,
  no: number,
  read: (reader: BinaryReader) => number,
): number | undefined {
  const matches = fields?.filter((field) => field.no === no && field.wireType === WireType.Varint);
  const field = matches?.[matches.length - 1];
  if (!field) return undefined;
  try {
    return read(new BinaryReader(field.data));
  } catch {
    return undefined;
  }
}

/** Encode a varint bool unknown field. */
export function unknownBoolField(no: number, value: boolean): UnknownField {
  return { no, wireType: WireType.Varint, data: new BinaryWriter().bool(value).finish() };
}

/**
 * The serialized message inside a length-delimited unknown field, or
 * `undefined` when the length prefix is malformed.
 */
export function unknownMessageBytes(field: UnknownField): Uint8Array | undefined {
  try {
    const reader = new BinaryReader(field.data);
    const bytes = reader.bytes();
    return reader.pos === reader.len ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Encode `message` (already serialized) as a length-delimited unknown field. */
export function unknownMessageField(no: number, message: Uint8Array): UnknownField {
  return {
    no,
    wireType: WireType.LengthDelimited,
    data: new BinaryWriter().bytes(message).finish(),
  };
}