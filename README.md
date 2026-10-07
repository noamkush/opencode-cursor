# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## OpenCode V2

Install the plugin:

```sh
opencode plugin add opencode-cursor-oauth
```

The command adds the package to your global V2 configuration.

Start `opencode`.
Run `/connect`.
Select Cursor.

The plugin registers Cursor OAuth and a provider with the available models using
the V2 provider API. Model discovery is scoped to the active Cursor connection;
switching accounts refreshes the model inventory, and disconnecting removes it.

You can also add the package directly to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-cursor-oauth"
  ]
}
```

## OpenCode V1

Add the package to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ]
}
```

Connect Cursor:

```sh
opencode auth login --provider cursor
```

OpenCode V1 and OpenCode V2 add the `cursor` provider and its models.
OpenCode installs npm plugins during startup.
You do not have to clone this repository.

### Tool compatibility

Cursor's tool-argument names are renamed to the names each OpenCode tool
advertises (`filePath` in OpenCode V1, `path` in V2), and only when that name
is unambiguous. Write and edit content is passed through literally.

Read results from OpenCode V1 and V2 reach Cursor as plain file content,
without OpenCode's line numbers. Native reads forward positive offsets and
limits. EOF-relative negative offsets are rejected so Cursor can retry using
the MCP read tool, without the proxy opening files outside OpenCode's
permission boundary. Cut-off reads keep their
continuation guidance; when a file's full line count or size is unavailable,
the proxy reports a lower bound or unknown.

Typed tool failures are carried explicitly across OpenAI Chat serialization so
Cursor receives errors rather than successful reads containing error text. V2
uses Cursor-scoped request hooks; V1 passes failed call IDs from session history.
Failures reach Cursor as their plain message, and a read of a missing file is
reported as not found so Cursor's write tool can create new files.

Cursor is told the session directory as its workspace root, and native `ls` and
`grep` results report absolute paths, so the model resolves relative paths
against the same directory OpenCode does.

Native shell calls can redirect to either `bash` or `shell`, using only arguments
advertised by that tool. Unavailable streaming-shell calls receive a streaming
rejection before closing, rather than an unrecognized non-streaming response.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — redirects Cursor's built-in filesystem/shell tools
   to the equivalent OpenCode tools, and exposes OpenCode's tool surface via
   Cursor MCP.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model calls a tool:
   - native tools (readArgs, shellArgs, grepArgs, ...) with an OpenCode
     equivalent are redirected to it (read, bash, grep, glob, webfetch, write)
   - native tools without an equivalent are rejected with a typed error
   - MCP tools arrive as mcpArgs exec messages
3. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
4. OpenCode executes tool, sends result in follow-up request
5. Proxy resumes H2 stream with the typed native result (or mcpResult),
   streams continuation
```

### Conversation state

Conversation history is rebuilt from the OpenAI messages on every request
(`rootPromptMessagesJson` + content-addressed turn blobs), and server
checkpoints are persisted to `~/.cache/opencode-cursor/conversations/` so
context survives restarts. State is keyed by the OpenCode session, the request
kind (primary, title, compaction, generate) and the opening prompt, so sessions
that start with the same prompt do not share a Cursor conversation. Set `CURSOR_PROXY_DEBUG=1` to log the KV blob
handshake, bridge stderr, stream lifecycle, and exec correlation traffic when
debugging. Diagnostics are appended as JSONL to
`$XDG_DATA_HOME/opencode/log/cursor-proxy.jsonl` (or
`~/.local/share/opencode/log/cursor-proxy.jsonl`), alongside OpenCode's data.

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription