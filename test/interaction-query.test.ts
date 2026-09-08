import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { buildInteractionResponse } from "../src/interaction-query";
import {
  AgentClientMessageSchema,
  InteractionQuerySchema,
  WebSearchRequestQuerySchema,
} from "../src/proto/agent_pb";

function responseFor(query: Parameters<typeof buildInteractionResponse>[0]) {
  const message = buildInteractionResponse(query);
  expect(message).not.toBeNull();
  expect(message!.message.case).toBe("interactionResponse");
  if (message!.message.case !== "interactionResponse") throw new Error("missing interaction response");
  return message!.message.value;
}

describe("buildInteractionResponse", () => {
  test("approves typed web search queries", () => {
    const response = responseFor(create(InteractionQuerySchema, {
      id: 7,
      query: {
        case: "webSearchRequestQuery",
        value: create(WebSearchRequestQuerySchema, {}),
      },
    }));

    expect(response.id).toBe(7);
    expect(response.result.case).toBe("webSearchRequestResponse");
    if (response.result.case === "webSearchRequestResponse") {
      expect(response.result.value.result.case).toBe("approved");
    }
  });

  test.each([
    ["askQuestionInteractionQuery", "askQuestionInteractionResponse", "rejected"],
    ["switchModeRequestQuery", "switchModeRequestResponse", "rejected"],
    ["createPlanRequestQuery", "createPlanRequestResponse", "error"],
  ] as const)("answers unsupported %s queries", (queryCase, responseCase, resultCase) => {
    const query = create(InteractionQuerySchema, { id: 8 });
    query.query = { case: queryCase, value: {} as never };
    const response = responseFor(query);
    expect(response.result.case).toBe(responseCase);
    expect((response.result.value as { result: { result?: { case: string }; case?: string } }).result.result?.case
      ?? (response.result.value as { result: { case?: string } }).result.case).toBe(resultCase);
  });

  test("approves only the verified unknown WebFetch field", () => {
    const webFetchQuery = fromBinary(InteractionQuerySchema, new Uint8Array([0x08, 0x09, 0x4a, 0x00]));
    const response = buildInteractionResponse(webFetchQuery);
    expect(response).not.toBeNull();
    const wire = toBinary(AgentClientMessageSchema, response!);
    const decoded = fromBinary(AgentClientMessageSchema, wire);
    expect(decoded.message.case).toBe("interactionResponse");
    if (decoded.message.case === "interactionResponse") {
      expect(decoded.message.value.$unknown?.map((field) => field.no)).toEqual([9]);
    }

    const futureQuery = fromBinary(InteractionQuerySchema, new Uint8Array([0x08, 0x09, 0x52, 0x00]));
    expect(buildInteractionResponse(futureQuery)).toBeNull();
  });

  test("does not claim VM setup succeeded", () => {
    const query = create(InteractionQuerySchema, { id: 10 });
    query.query = { case: "setupVmEnvironmentArgs", value: {} as never };
    expect(buildInteractionResponse(query)).toBeNull();
  });
});
