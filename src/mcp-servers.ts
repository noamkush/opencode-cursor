/**
 * OpenCode merges MCP tools into its tool list as `${server}_${tool}`, so the
 * proxy cannot tell them from built-in tools on its own. The plugin passes the
 * connected server names alongside each request instead.
 */
export const MCP_SERVERS_HEADER = "x-opencode-cursor-mcp-servers";

/** OpenCode's MCP name sanitizer, applied to both server and tool names. */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function encodeMcpServerNames(names: readonly string[]): string {
  return JSON.stringify([...new Set(names.map(sanitizeMcpName))]);
}

export function decodeMcpServerNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const names: unknown = JSON.parse(value);
    if (!Array.isArray(names)) return [];
    return [...new Set(names
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map(sanitizeMcpName))];
  } catch {
    return [];
  }
}

export function withMcpServerNames(request: Request, names: readonly string[]): Request {
  const headers = new Headers(request.headers);
  headers.set(MCP_SERVERS_HEADER, encodeMcpServerNames(names));
  return new Request(request, { headers });
}
