import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { decodeMcpServerNames, encodeMcpServerNames } from "../src/mcp-servers";
import {
  buildMcpRequestContextFields,
  buildMcpStateExecClientMessage,
  buildMcpToolDefinitions,
  describeUnknownExecFields,
  isMcpStateExecRequest,
  resolveMcpToolName,
} from "../src/proxy";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  McpArgsSchema,
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

/** Split a serialized message into its length-delimited fields by number. */
function messageFields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>();
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (wireType !== WireType.LengthDelimited) {
      reader.skip(wireType);
      continue;
    }
    fields.set(no, [...(fields.get(no) ?? []), reader.bytes()]);
  }
  return fields;
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

function tool(name: string) {
  return { type: "function" as const, function: { name, description: `${name} tool`, parameters: { type: "object" } } };
}

const tools = buildMcpToolDefinitions(
  [tool("read"), tool("jira_getJiraIssue"), tool("jira_cloud_search"), tool("jira_cloud")],
  decodeMcpServerNames(encodeMcpServerNames(["jira", "jira.cloud"])),
);

describe("mcp server attribution", () => {
  test("splits OpenCode MCP tool names into server and tool", () => {
    expect(tools.map((t) => [t.name, t.providerIdentifier, t.toolName])).toEqual([
      ["read", "opencode", "read"],
      ["jira_getJiraIssue", "jira", "getJiraIssue"],
      ["jira_cloud_search", "jira_cloud", "search"],
      // No tool part after the server name, so this cannot belong to jira_cloud.
      ["jira_cloud", "jira", "cloud"],
    ]);
  });

  test("describes only real MCP servers in the request context", () => {
    const [options, complete] = buildMcpRequestContextFields(tools);
    expect(options!.no).toBe(34);
    expect(complete).toEqual({ no: 36, wireType: WireType.Varint, data: new Uint8Array([1]) });

    const descriptors = messageFields(unwrapLengthDelimited(options!.data)).get(2)!.map(messageFields);
    expect(descriptors.map((d) => text(d.get(2)![0]))).toEqual(["jira", "jira_cloud"]);
    const jiraTools = descriptors[0]!.get(5)!.map((t) => text(messageFields(t).get(1)![0]));
    expect(jiraTools).toEqual(["getJiraIssue", "cloud"]);

    expect(buildMcpRequestContextFields(buildMcpToolDefinitions([tool("read")]))).toEqual([]);
  });

  test("reports each requested server in the MCP state result", () => {
    const args = new BinaryWriter().tag(1, WireType.LengthDelimited).string("jira")
      .tag(2, WireType.Varint).bool(false).finish();
    const exec = create(ExecServerMessageSchema, { id: 3 });
    exec.$unknown = [{ no: 36, wireType: WireType.LengthDelimited, data: new BinaryWriter().bytes(args).finish() }];

    const response = buildMcpStateExecClientMessage(exec, tools);
    if (response.message.case !== "execClientMessage") throw new Error("missing exec response");
    const result = unwrapLengthDelimited(response.message.value.$unknown!.find((f) => f.no === 36)!.data);
    const servers = messageFields(messageFields(result).get(1)![0]!).get(1)!.map(messageFields);
    expect(servers.map((server) => text(server.get(2)![0]))).toEqual(["jira"]);
    expect(servers[0]!.get(5)).toHaveLength(2);
    expect(text(servers[0]!.get(7)![0])).toBe("connected");
  });

  test("maps Cursor MCP calls back to OpenCode tool names", () => {
    const call = (fields: { providerIdentifier?: string; toolName: string; name?: string }, serverIdentifier?: string) => {
      const args = create(McpArgsSchema, fields);
      if (serverIdentifier) {
        args.$unknown = [{
          no: 9,
          wireType: WireType.LengthDelimited,
          data: new BinaryWriter().string(serverIdentifier).finish(),
        }];
      }
      return resolveMcpToolName(args, tools);
    };
    expect(call({ toolName: "getJiraIssue" }, "jira")).toBe("jira_getJiraIssue");
    expect(call({ providerIdentifier: "jira_cloud", toolName: "search" })).toBe("jira_cloud_search");
    expect(call({ providerIdentifier: "opencode", toolName: "read" })).toBe("read");
    expect(call({ toolName: "jira_getJiraIssue", name: "jira_getJiraIssue" })).toBe("jira_getJiraIssue");
    expect(call({ toolName: "getJiraIssue" })).toBe("jira_getJiraIssue");
  });
});
