/** Preserve typed tool failures across OpenAI Chat's text-only tool messages. */
export const TOOL_ERRORS_HEADER = "x-opencode-cursor-tool-errors";

export function collectToolErrorIds(messages: readonly {
  content: readonly { type: string; id?: string; result?: { type: string } }[];
}[]): Set<string> {
  return new Set(messages.flatMap((message) => message.content.flatMap((part) =>
    part.type === "tool-result" && part.result?.type === "error" && part.id ? [part.id] : [],
  )));
}

export function decodeToolErrorIds(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const ids: unknown = JSON.parse(value);
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Annotate only the actual serialized tool messages, never infer from text. */
export async function markToolErrors(request: Request, ids: ReadonlySet<string>): Promise<Request> {
  if (!ids.size || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return request;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return request;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return request;
  let changed = false;
  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "tool" || !ids.has(message.tool_call_id)) continue;
    message.is_error = true;
    changed = true;
  }
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: JSON.stringify(body) });
}

/**
 * OpenCode serializes structured tool failures as JSON
 * (`{"error":{"type","message"},"content":[...]}`). Reduce them to the
 * message and any partial text output so Cursor sees readable errors.
 */
export function toolErrorText(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return text;
  const { error, content } = value as Record<string, unknown>;
  if (!error || typeof error !== "object" || typeof (error as Record<string, unknown>).message !== "string") return text;
  const parts = Array.isArray(content)
    ? content.flatMap((part) => part?.type === "text" && typeof part.text === "string" && part.text ? [part.text] : [])
    : [];
  return [(error as { message: string }).message, ...parts].join("\n\n");
}
