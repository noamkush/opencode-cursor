/**
 * The proxy keeps Cursor conversation state between requests. Request bodies
 * carry no session identity, so the plugin passes the OpenCode session and the
 * request kind alongside each request; otherwise sessions that open with the
 * same prompt would share one Cursor conversation.
 */
export const SESSION_HEADER = "x-opencode-cursor-session";

/** OpenCode V2 request kinds; V1 maps its hidden agents onto the same set. */
export type SessionRequestKind = "primary" | "compaction" | "generate" | "title";

const V1_AGENT_KINDS: Record<string, SessionRequestKind> = {
  title: "title",
  summary: "generate",
  compaction: "compaction",
};

export function v1RequestKind(agent: string): SessionRequestKind {
  return V1_AGENT_KINDS[agent] ?? "primary";
}

export function encodeSessionKey(sessionID: string, kind: string): string {
  return encodeURIComponent(`${sessionID}:${kind}`);
}

/** The session key, or `undefined` when missing or malformed. */
export function decodeSessionKey(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}

export function withSessionKey(request: Request, sessionID: string, kind: string): Request {
  const headers = new Headers(request.headers);
  headers.set(SESSION_HEADER, encodeSessionKey(sessionID, kind));
  return new Request(request, { headers });
}
