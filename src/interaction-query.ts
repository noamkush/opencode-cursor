import { create } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  AgentClientMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  type AgentClientMessage,
  type InteractionQuery,
  InteractionResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  SwitchModeRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
} from "./proto/agent_pb";
import { findUnknownField, INTERACTION_WEB_FETCH_FIELD, unknownMessageField } from "./unknown-fields";

const NOT_IMPLEMENTED = "not implemented by this client";

/** Build the response for interaction queries this headless proxy can answer faithfully. */
export function buildInteractionResponse(query: InteractionQuery): AgentClientMessage | null {
  const response = create(InteractionResponseSchema, { id: query.id });

  switch (query.query.case) {
    case "webSearchRequestQuery":
      response.result = {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    case "exaSearchRequestQuery":
      response.result = {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaSearchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    case "exaFetchRequestQuery":
      response.result = {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaFetchRequestResponse_ApprovedSchema, {}) },
        }),
      };
      break;
    case "askQuestionInteractionQuery":
      response.result = {
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: {
              case: "rejected",
              value: create(AskQuestionRejectedSchema, {
                reason: `Interactive questions are ${NOT_IMPLEMENTED}`,
              }),
            },
          }),
        }),
      };
      break;
    case "switchModeRequestQuery":
      response.result = {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(SwitchModeRequestResponse_RejectedSchema, {
              reason: `Mode switches are ${NOT_IMPLEMENTED}`,
            }),
          },
        }),
      };
      break;
    case "createPlanRequestQuery":
      response.result = {
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            result: {
              case: "error",
              value: create(CreatePlanErrorSchema, { error: `Plan files are ${NOT_IMPLEMENTED}` }),
            },
          }),
        }),
      };
      break;
    case "setupVmEnvironmentArgs":
      // The local schema is success-only, and this proxy does not provision a VM.
      return null;
    case undefined: {
      const webFetch = findUnknownField(
        query.$unknown,
        INTERACTION_WEB_FETCH_FIELD,
        WireType.LengthDelimited,
      );
      if (!webFetch) return null;

      // The response payload is WebFetchRequestResponse { approved: {} }.
      // Keep this narrowly allowlisted.
      const approved = new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(new Uint8Array()).finish();
      response.$unknown = [unknownMessageField(INTERACTION_WEB_FETCH_FIELD, approved)];
      break;
    }
  }

  return create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
}