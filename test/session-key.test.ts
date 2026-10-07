import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deriveBridgeKey, deriveConversationKey, type OpenAIMessage } from "../src/proxy";
import {
  decodeSessionKey,
  encodeSessionKey,
  SESSION_HEADER,
  v1RequestKind,
  withSessionKey,
} from "../src/session-key";

const messages: OpenAIMessage[] = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "Review this change" },
];

describe("session key header", () => {
  test("round-trips session and kind", () => {
    expect(decodeSessionKey(encodeSessionKey("ses_ä/1", "title"))).toBe("ses_ä/1:title");
  });

  test("rejects missing and malformed values", () => {
    expect(decodeSessionKey(null)).toBeUndefined();
    expect(decodeSessionKey("")).toBeUndefined();
    expect(decodeSessionKey("%E0%A4%A")).toBeUndefined();
  });

  test("sets the header on V2 requests", () => {
    const request = withSessionKey(new Request("http://localhost/v1/chat/completions"), "ses_1", "primary");
    expect(decodeSessionKey(request.headers.get(SESSION_HEADER))).toBe("ses_1:primary");
  });

  test("maps V1 hidden agents to request kinds", () => {
    expect(v1RequestKind("build")).toBe("primary");
    expect(v1RequestKind("plan")).toBe("primary");
    expect(v1RequestKind("title")).toBe("title");
    expect(v1RequestKind("compaction")).toBe("compaction");
  });
});

describe("conversation keys", () => {
  test("separate sessions that open with the same prompt", () => {
    expect(deriveConversationKey(messages, "ses_a:primary"))
      .not.toBe(deriveConversationKey(messages, "ses_b:primary"));
    expect(deriveBridgeKey("model", messages, "ses_a:primary"))
      .not.toBe(deriveBridgeKey("model", messages, "ses_b:primary"));
  });

  test("separate a session's title request from its primary conversation", () => {
    const title: OpenAIMessage[] = [{ role: "user", content: "Review this change" }];
    expect(deriveConversationKey(title, "ses_a:title"))
      .not.toBe(deriveConversationKey(messages, "ses_a:primary"));
    expect(deriveBridgeKey("model", title, "ses_a:title"))
      .not.toBe(deriveBridgeKey("model", messages, "ses_a:primary"));
  });

  test("stay stable across turns of one session", () => {
    const later: OpenAIMessage[] = [
      ...messages,
      { role: "assistant", content: "Looks good." },
      { role: "user", content: "Now add tests" },
    ];
    expect(deriveConversationKey(later, "ses_a:primary")).toBe(deriveConversationKey(messages, "ses_a:primary"));
  });

  test("keep the prompt-only key without a session header", () => {
    const legacy = createHash("sha256").update("conv:Review this change").digest("hex").slice(0, 16);
    expect(deriveConversationKey(messages)).toBe(legacy);
  });
});
