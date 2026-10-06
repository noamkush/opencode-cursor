/**
 * Native tool redirection.
 *
 * Cursor models aggressively call their built-in tools (read, shell, grep,
 * ls, write, fetch) before falling back to MCP tools. Rejecting those calls
 * burns model round-trips and confuses the model ("Tool not available in
 * this environment", issues #21/#29). When the client provides an equivalent
 * OpenAI tool, redirect the native call to it and convert the tool result
 * back into Cursor's typed native result frame.
 */
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepCountResultSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepErrorSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsErrorSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadResultSchema,
  ReadErrorSchema,
  ReadSuccessSchema,
  ShellFailureSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteResultSchema,
  WriteErrorSchema,
  WriteSuccessSchema,
  type ExecServerMessage,
  type LsDirectoryTreeNode,
  type McpToolDefinition,
} from "./proto/agent_pb";
import {
  READ_ARGS_LIMIT_FIELD,
  READ_ARGS_OFFSET_FIELD,
  READ_SUCCESS_RANGE_APPLIED_FIELD,
  readUnknownInt32,
  readUnknownUint32,
  unknownBoolField,
} from "./unknown-fields";

export type NativeResultType =
  | "readResult"
  | "writeResult"
  | "fetchResult"
  | "shellResult"
  | "shellStreamResult"
  | "lsResult"
  | "grepResult";

/** How to answer the paused native exec once the redirected tool result arrives. */
export interface NativeExecBinding {
  resultType: NativeResultType;
  /** Native arg values needed to shape the typed result frame. */
  args: Record<string, string>;
}

export interface NativeRedirect {
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  binding: NativeExecBinding;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Pick the first matching canonical/alias value, drop aliases, set the canonical key. */
function rewriteArgAliases(
  args: Record<string, unknown>,
  key: string,
  aliases: readonly string[],
  pick: (value: unknown) => unknown,
): Record<string, unknown> {
  const value = [key, ...aliases]
    .map((name) => pick(args[name]))
    .find((candidate) => candidate !== undefined);
  if (value === undefined) return args;

  const next: Record<string, unknown> = { ...args };
  for (const alias of aliases) delete next[alias];
  next[key] = value;
  return next;
}

function inputProperties(tool: McpToolDefinition | undefined): Record<string, unknown> {
  if (!tool?.inputSchema.length) return {};
  try {
    const schema = toJson(ValueSchema, fromBinary(ValueSchema, tool.inputSchema));
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
    const properties = schema.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};
  } catch {
    return {};
  }
}

export function filePathKey(tool: McpToolDefinition | undefined): "path" | "filePath" | undefined {
  const properties = inputProperties(tool);
  // An ambiguous or missing schema is not permission to rename arguments.
  if (Object.hasOwn(properties, "path") === Object.hasOwn(properties, "filePath")) return undefined;
  return Object.hasOwn(properties, "path") ? "path" : "filePath";
}

/**
 * Cursor calls use native param names (path, globPattern, old_string, ...).
 * Normalize only aliases whose canonical field is actually advertised.
 */
export function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  tools: readonly McpToolDefinition[],
): Record<string, unknown> {
  const tool = tools.find((tool) => (tool.name || tool.toolName) === toolName);
  const properties = inputProperties(tool);
  if (["read", "edit", "write", "lsp"].includes(toolName)) {
    const key = filePathKey(tool);
    if (key) args = rewriteArgAliases(args, key, ["path", "filePath", "filepath"].filter((alias) => alias !== key && !Object.hasOwn(properties, alias)), nonEmptyString);
  }
  if (toolName === "glob") {
    if (Object.hasOwn(properties, "pattern")) args = rewriteArgAliases(args, "pattern", ["globPattern", "glob_pattern"].filter((key) => !Object.hasOwn(properties, key)), nonEmptyString);
    if (Object.hasOwn(properties, "path")) args = rewriteArgAliases(args, "path", ["target_directory", "targetDirectory"].filter((key) => !Object.hasOwn(properties, key)), nonEmptyString);
  }
  if (toolName === "edit") {
    for (const [key, alias, pick] of [
      ["oldString", "old_string", asString],
      ["newString", "new_string", asString],
      ["replaceAll", "replace_all", asBoolean],
    ] as const) {
      if (Object.hasOwn(properties, key) && !Object.hasOwn(properties, alias)) args = rewriteArgAliases(args, key, [alias], pick);
    }
  }
  return args;
}

const OPENCODE_READ_PREFIX = /^\d+: /;
const CURSOR_READ_PREFIX = /^\s*\d+\|/;
const READ_FOOTER =
  /\n\n\((?:End of file - total \d+ lines|Showing lines .+|Output capped at .+)\)\s*$/;
const FILE_ENVELOPE =
  /^(?:\s*)<path>[\s\S]*?<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>/;
const END_OF_FILE_FOOTER = /\(End of file - total (\d+) lines\)/;
const PARTIAL_FOOTER = /\(Showing lines (\d+)-(\d+) of (\d+)\./;
const CAPPED_FOOTER = /\(Output capped at [^.]+\. Showing lines (\d+)-(\d+)\./;
const LONG_LINE_SUFFIX = /\.\.\. \(line truncated to \d+ chars\)$/m;
const V2_READ_HEADER = /^Read file .+, (?:0 lines|lines (\d+)-(\d+))$/;
const V2_READ_TRUNCATED = /^\[Output truncated\. Continue reading with offset: (\d+)\]$/;

/** Strip Read line numbers only when every nonempty line is numbered output. */
function stripReadLinePrefixes(text: string): string {
  const lines = text.split("\n");
  const nonempty = lines.filter((line) => line.length > 0);
  if (nonempty.length === 0) return text;
  if (nonempty.every((line) => OPENCODE_READ_PREFIX.test(line))) {
    return lines.map((line) => line.replace(OPENCODE_READ_PREFIX, "")).join("\n");
  }
  if (nonempty.every((line) => CURSOR_READ_PREFIX.test(line))) {
    return lines.map((line) => line.replace(CURSOR_READ_PREFIX, "")).join("\n");
  }
  return text;
}

/**
 * Convert OpenCode Read output to plain file content. Unwraps one V1
 * `<path>`, `<type>file</type>`, `<content>` envelope or a V2
 * `Read file ..., lines a-b` page, strips numbered prefixes from the
 * lines, and drops the Read footer unless `keepFooter` is set. The footer
 * is the only sign that a read stopped early, so results shown to the
 * model should keep it.
 */
export function unwrapReadOutput(
  text: string,
  options: { keepFooter?: boolean } = {},
): string {
  const parsed = parseReadEnvelope(text);
  if (!parsed) {
    const page = parseReadPage(text);
    if (!page) return text;
    if (!options.keepFooter || page.last === 0) return page.content;
    const continuation = page.next === undefined
      ? " End of file."
      : ` Total line count is unknown. Use offset=${page.next} to continue.`;
    return `${page.content}\n\n(Showing lines ${page.first}-${page.last}.${continuation})`;
  }
  return options.keepFooter && parsed.footer ? parsed.content + parsed.footer : parsed.content;
}

/** Parse V2 Read text only when every line has the exact expected shape. */
function parseReadPage(text: string) {
  const lines = text.split("\n");
  const header = lines[0]!.match(V2_READ_HEADER);
  if (!header) return null;
  const first = header[1] ? Number(header[1]) : 1;
  const last = header[2] ? Number(header[2]) : 0;
  const count = header[1] ? last - first + 1 : 0;
  if (count < 0 || lines.length < count + 1) return null;
  const content: string[] = [];
  for (let index = 0; index < count; index++) {
    const prefix = `${first + index}: `;
    const line = lines[index + 1]!;
    if (!line.startsWith(prefix)) return null;
    content.push(line.slice(prefix.length));
  }
  const rest = lines.slice(count + 1);
  while (rest.at(-1) === "") rest.pop();
  if (rest.length > 1) return null;
  const truncated = rest[0]?.match(V2_READ_TRUNCATED);
  if (rest.length === 1 && !truncated) return null;
  return { content: content.join("\n"), first, last, next: truncated ? Number(truncated[1]) : undefined };
}

function parseReadEnvelope(text: string) {
  const match = text.match(FILE_ENVELOPE);
  if (!match) return null;
  const inner = match[1]!;
  const footer = inner.match(READ_FOOTER);
  return {
    content: stripReadLinePrefixes(footer ? inner.slice(0, footer.index) : inner),
    footer: footer?.[0],
  };
}

function textLineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Record what an OpenCode read actually returned so the native readResult
 * reports known totals rather than treating the returned chunk as the whole
 * file. Missing totals remain unknown; this layer must not open local files.
 */
export function bindReadOutput(binding: NativeExecBinding, output: string): NativeExecBinding {
  const page = parseReadPage(output);
  if (page) {
    // V2 does not report the file's total. A page without a continuation
    // reached the end of the file; otherwise line `next` is known to exist.
    return {
      ...binding,
      args: {
        ...binding.args,
        totalLines: String(page.next ?? page.last),
        fileSize: "0",
        truncated: String(page.next !== undefined || LONG_LINE_SUFFIX.test(page.content)),
        ...(page.next !== undefined || page.first !== 1 ? { rangeApplied: "true" } : undefined),
      },
    };
  }
  const parsed = parseReadEnvelope(output);
  if (!parsed) return binding;
  const args = binding.args;
  const footer = parsed.footer ?? "";
  const limit = args.limit ? Number(args.limit) : undefined;

  let totalLines: number | undefined;
  let truncated = LONG_LINE_SUFFIX.test(parsed.content);
  const end = footer.match(END_OF_FILE_FOOTER);
  const partial = footer.match(PARTIAL_FOOTER);
  const capped = footer.match(CAPPED_FOOTER);
  if (end) {
    totalLines = Number(end[1]);
  } else if (partial) {
    totalLines = Number(partial[3]);
    const [first, last] = [Number(partial[1]), Number(partial[2])];
    truncated ||= limit === undefined || last < first + limit - 1;
  } else if (capped) {
    // The total is unknown, but the next line exists.
    totalLines = Number(capped[2]) + 1;
    truncated = true;
  }

  return {
    ...binding,
    args: {
      ...args,
      ...(totalLines !== undefined ? { totalLines: String(totalLines) } : undefined),
      fileSize: "0",
      ...(truncated ? { truncated: "true" } : undefined),
    },
  };
}

/**
 * Map a native exec request onto a client-provided OpenAI tool.
 * Returns null when no equivalent tool is available (caller rejects as before).
 */
export function redirectNativeExec(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
): NativeRedirect | null {
  const execCase = execMsg.message.case;
  const available = new Set(
    mcpTools.map((tool) => tool.name || tool.toolName).filter(Boolean),
  );
  const pick = (candidates: string[]) =>
    candidates.find((name) => available.has(name));

  if (execCase === "readArgs") {
    const args = execMsg.message.value;
    const toolName = pick(["read"]);
    if (!toolName) return null;
    const tool = mcpTools.find((tool) => (tool.name || tool.toolName) === toolName);
    const key = filePathKey(tool);
    if (!key) return null;
    // OpenCode cannot express EOF-relative offsets. Reject rather than
    // silently reading a capped first page or bypassing tool permissions.
    const offset = readUnknownInt32(args.$unknown, READ_ARGS_OFFSET_FIELD);
    if ((offset ?? 0) < 0) return null;
    const limit = readUnknownUint32(args.$unknown, READ_ARGS_LIMIT_FIELD);
    const range = { ...(offset ? { offset } : undefined), ...(limit ? { limit } : undefined) };
    const properties = inputProperties(tool);
    if (Object.keys(range).some((field) => !Object.hasOwn(properties, field))) return null;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify({ [key]: args.path ?? "", ...range }),
      binding: {
        resultType: "readResult",
        args: {
          path: args.path ?? "",
          ...(range.offset ? { offset: String(range.offset) } : undefined),
          ...(range.limit ? { limit: String(range.limit) } : undefined),
        },
      },
    };
  }

  if (execCase === "writeArgs") {
    const args = execMsg.message.value;
    const toolName = pick(["write"]);
    if (!toolName) return null;
    const key = filePathKey(mcpTools.find((tool) => (tool.name || tool.toolName) === toolName));
    if (!key) return null;
    const content =
      args.fileBytes && args.fileBytes.length > 0
        ? new TextDecoder().decode(args.fileBytes)
        : (args.fileText ?? "");
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify({ [key]: args.path ?? "", content }),
      binding: {
        resultType: "writeResult",
        args: {
          path: args.path ?? "",
          fileSize: String(new TextEncoder().encode(content).byteLength),
          linesCreated: String(content.split("\n").length),
        },
      },
    };
  }

  if (execCase === "fetchArgs") {
    const args = execMsg.message.value;
    const toolName = pick(["webfetch", "fetch", "web_fetch"]);
    if (!toolName) return null;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify({ url: args.url ?? "", format: "markdown" }),
      binding: { resultType: "fetchResult", args: { url: args.url ?? "" } },
    };
  }

  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const args = execMsg.message.value;
    const toolName = pick(["bash"]);
    if (!toolName) return null;
    const decodedArgs: Record<string, unknown> = {
      command: args.command ?? "",
      description: "Runs shell command",
    };
    if (args.workingDirectory) decodedArgs.workdir = args.workingDirectory;
    if (args.timeout > 0) decodedArgs.timeout = args.timeout;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decodedArgs),
      binding: {
        resultType: execCase === "shellStreamArgs" ? "shellStreamResult" : "shellResult",
        args: {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
        },
      },
    };
  }

  if (execCase === "lsArgs") {
    const args = execMsg.message.value;
    const toolName = pick(["glob"]);
    if (!toolName) return null;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify({ pattern: "*", path: args.path ?? "" }),
      binding: { resultType: "lsResult", args: { path: args.path ?? "" } },
    };
  }

  if (execCase === "grepArgs") {
    const args = execMsg.message.value;
    if (!args.pattern && args.glob) {
      const globTool = pick(["glob"]);
      if (!globTool) return null;
      return {
        toolCallId: args.toolCallId || crypto.randomUUID(),
        toolName: globTool,
        decodedArgs: JSON.stringify({
          pattern: args.glob,
          path: args.path ?? "",
        }),
        binding: {
          resultType: "grepResult",
          args: {
            pattern: args.glob,
            path: args.path ?? "",
            outputMode: "files_with_matches",
          },
        },
      };
    }
    const toolName = pick(["grep"]);
    if (!toolName) return null;
    const decodedArgs: Record<string, unknown> = { pattern: args.pattern || "." };
    if (args.path) decodedArgs.path = args.path;
    if (args.glob) decodedArgs.include = args.glob;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decodedArgs),
      binding: {
        resultType: "grepResult",
        args: {
          pattern: args.pattern || ".",
          path: args.path ?? "",
          outputMode: args.outputMode || "content",
          ...(args.multiline ? { multiline: "true" } : undefined),
        },
      },
    };
  }

  return null;
}

interface PendingNativeExec {
  execId: string;
  execMsgId: number;
}

/**
 * Convert the redirected tool's text result into the typed native result the
 * paused exec expects. Returns false when no faithful conversion exists
 * (caller falls back to an mcpResult).
 * `sendMessage` receives an unframed AgentClientMessage binary.
 */
export function sendNativeExecResult(
  exec: PendingNativeExec,
  binding: NativeExecBinding,
  text: string,
  isError: boolean,
  sendMessage: (bytes: Uint8Array) => void,
): boolean {
  const args = binding.args;

  const sendExec = (messageCase: string, value: unknown) => {
    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: {
        case: messageCase as never,
        value: value as never,
      },
    });
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });
    sendMessage(toBinary(AgentClientMessageSchema, clientMessage));
  };

  switch (binding.resultType) {
    case "readResult": {
      if (isError) {
        sendExec("readResult", create(ReadResultSchema, {
          result: {
            case: "error",
            value: create(ReadErrorSchema, { path: args.path ?? "", error: text || "Read failed" }),
          },
        }));
        return true;
      }
      // Cursor checks offsets against totalLines, so an unknown total must
      // still cover every line returned.
      const offset = args.offset ? Number(args.offset) : 1;
      const success = create(ReadSuccessSchema, {
        path: args.path ?? "",
        totalLines: args.totalLines !== undefined ? Number(args.totalLines) : offset - 1 + textLineCount(text),
        fileSize: BigInt(args.fileSize ?? 0),
        truncated: args.truncated === "true",
        output: { case: "content", value: text },
      });
      if (args.rangeApplied === "true" || args.offset || args.limit) {
        success.$unknown = [unknownBoolField(READ_SUCCESS_RANGE_APPLIED_FIELD, true)];
      }
      sendExec(
        "readResult",
        create(ReadResultSchema, { result: { case: "success", value: success } }),
      );
      return true;
    }

    case "writeResult": {
      if (isError) {
        sendExec("writeResult", create(WriteResultSchema, {
          result: {
            case: "error",
            value: create(WriteErrorSchema, { path: args.path ?? "", error: text || "Write failed" }),
          },
        }));
        return true;
      }
      sendExec(
        "writeResult",
        create(WriteResultSchema, {
          result: {
            case: "success",
            value: create(WriteSuccessSchema, {
              path: args.path ?? "",
              fileSize: Number(args.fileSize ?? 0),
              linesCreated: Number(args.linesCreated ?? 0),
            }),
          },
        }),
      );
      return true;
    }

    case "fetchResult": {
      if (isError) {
        sendExec("fetchResult", create(FetchResultSchema, {
          result: {
            case: "error",
            value: create(FetchErrorSchema, { url: args.url ?? "", error: text || "Fetch failed" }),
          },
        }));
        return true;
      }
      sendExec(
        "fetchResult",
        create(FetchResultSchema, {
          result: {
            case: "success",
            value: create(FetchSuccessSchema, {
              url: args.url ?? "",
              content: text,
              statusCode: 200,
            }),
          },
        }),
      );
      return true;
    }

    case "shellResult": {
      const common = {
        command: args.command ?? "",
        workingDirectory: args.workingDirectory ?? "",
        exitCode: isError ? 1 : 0,
        signal: "",
        stdout: isError ? "" : text,
        stderr: isError ? text || "Command failed" : "",
      };
      sendExec(
        "shellResult",
        create(ShellResultSchema, {
          result: isError
            ? { case: "failure", value: create(ShellFailureSchema, common) }
            : { case: "success", value: create(ShellSuccessSchema, common) },
        }),
      );
      return true;
    }

    case "shellStreamResult": {
      sendExec(
        "shellStream",
        create(ShellStreamSchema, {
          event: { case: "start", value: create(ShellStreamStartSchema, {}) },
        }),
      );
      if (text) {
        const event = isError
          ? { case: "stderr" as const, value: create(ShellStreamStderrSchema, { data: text }) }
          : { case: "stdout" as const, value: create(ShellStreamStdoutSchema, { data: text }) };
        sendExec(
          "shellStream",
          create(ShellStreamSchema, { event }),
        );
      }
      sendExec(
        "shellStream",
        create(ShellStreamSchema, {
          event: { case: "exit", value: create(ShellStreamExitSchema, { code: isError ? 1 : 0 }) },
        }),
      );
      return true;
    }

    case "lsResult": {
      if (isError) {
        sendExec("lsResult", create(LsResultSchema, {
          result: {
            case: "error",
            value: create(LsErrorSchema, { path: args.path ?? "", error: text || "List failed" }),
          },
        }));
        return true;
      }
      const built = buildLsResult(text, args.path ?? "");
      if (!built) return false;
      sendExec("lsResult", built);
      return true;
    }

    case "grepResult": {
      if (isError) {
        sendExec("grepResult", create(GrepResultSchema, {
          result: { case: "error", value: create(GrepErrorSchema, { error: text || "Grep failed" }) },
        }));
        return true;
      }
      const built = buildGrepResult(text, args);
      if (!built) return false;
      sendExec("grepResult", built);
      return true;
    }
  }
}

/** Reconstruct Cursor's directory tree from glob output (one path per line). */
export function buildLsResult(content: string, rootPath: string) {
  const rawLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedRoot = lsRoot(rootPath, rawLines);

  const root = create(LsDirectoryTreeNodeSchema, {
    absPath: normalizedRoot,
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts: {},
    numFiles: 0,
  });

  const dirMap = new Map<string, LsDirectoryTreeNode>([[normalizedRoot, root]]);

  for (const rawLine of rawLines) {
    const normalized = normalizeListedPath(rawLine, normalizedRoot);
    if (!normalized || normalized === normalizedRoot) continue;
    const relative =
      normalizedRoot !== "." && normalized.startsWith(dirPrefix(normalizedRoot))
        ? normalized.slice(dirPrefix(normalizedRoot).length)
        : normalized;
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let currentPath = normalizedRoot;
    let currentNode = dirMap.get(normalizedRoot)!;
    for (const segment of parts.slice(0, -1)) {
      const nextPath = joinPath(currentPath, segment);
      let nextNode = dirMap.get(nextPath);
      if (!nextNode) {
        nextNode = create(LsDirectoryTreeNodeSchema, {
          absPath: nextPath,
          childrenDirs: [],
          childrenFiles: [],
          childrenWereProcessed: true,
          fullSubtreeExtensionCounts: {},
          numFiles: 0,
        });
        currentNode.childrenDirs.push(nextNode);
        dirMap.set(nextPath, nextNode);
      }
      currentPath = nextPath;
      currentNode = nextNode;
    }

    const leaf = parts.at(-1)!;
    currentNode.childrenFiles.push(
      create(LsDirectoryTreeNode_FileSchema, { name: leaf }),
    );
  }

  computeLsStats(root);

  return create(LsResultSchema, {
    result: {
      case: "success",
      value: create(LsSuccessSchema, { directoryTreeRoot: root }),
    },
  });
}

function normalizeListedPath(path: string, rootPath: string): string {
  const cleaned = path.replace(/\/$/, "");
  if (!cleaned) return "";
  if (cleaned === ".") return rootPath || ".";
  if (cleaned.startsWith("/")) return cleaned;
  if (cleaned === rootPath || cleaned.startsWith(`${rootPath}/`)) return cleaned;
  if (rootPath && rootPath !== ".") return joinPath(rootPath, cleaned);
  return cleaned;
}

/**
 * Glob lists absolute paths. Splitting one under a relative root would drop
 * its leading slash, so root the tree at the listed paths' common directory.
 */
function lsRoot(rootPath: string, lines: readonly string[]): string {
  if (rootPath.startsWith("/")) return rootPath.replace(/(.)\/+$/, "$1");
  const paths = lines.map((line) => line.replace(/\/$/, ""));
  if (paths.length === 0 || !paths.every((path) => path.startsWith("/"))) return rootPath || ".";
  const dirs = paths.map((path) => path.split("/").filter(Boolean).slice(0, -1));
  const common: string[] = [];
  for (const [index, segment] of dirs[0]!.entries()) {
    if (!dirs.every((dir) => dir[index] === segment)) break;
    common.push(segment);
  }
  return `/${common.join("/")}`;
}

function dirPrefix(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

function joinPath(base: string, segment: string): string {
  if (!base || base === ".") return segment;
  return `${dirPrefix(base)}${segment}`;
}

function computeLsStats(node: LsDirectoryTreeNode): void {
  const extensionCounts: Record<string, number> = {};
  let numFiles = node.childrenFiles.length;

  for (const file of node.childrenFiles) {
    const dot = file.name.lastIndexOf(".");
    if (dot > 0 && dot < file.name.length - 1) {
      const ext = file.name.slice(dot + 1);
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    }
  }

  for (const child of node.childrenDirs) {
    computeLsStats(child);
    numFiles += child.numFiles;
    for (const [ext, count] of Object.entries(child.fullSubtreeExtensionCounts)) {
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + count;
    }
  }

  node.numFiles = numFiles;
  node.fullSubtreeExtensionCounts = extensionCounts;
}

/**
 * Parse grep/glob tool text into Cursor's structured result.
 * OpenCode grep is `path:` headers and `  Line N:` records. A pattern-less
 * grep is served by glob, which lists one path per line.
 */
export function buildGrepResult(content: string, args: Record<string, string>) {
  if (content.includes("Ripgrep JSON record exceeded")) {
    return create(GrepResultSchema, {
      result: {
        case: "error",
        value: create(GrepErrorSchema, {
          error: `${content.trim()} Retry with a more specific path or include glob.`,
        }),
      },
    });
  }

  const pattern = args.pattern ?? "";
  const path = args.path ?? "";
  const outputMode = args.outputMode || "content";

  if (args.multiline === "true") return null;
  if (!["content", "files_with_matches", "count"].includes(outputMode)) {
    return null;
  }

  const lines = grepLines(content);
  const truncated = isGrepTruncated(lines);
  const matches = parseOpenCodeGrep(lines);
  // Line records that never name a file are not an empty search.
  if (matches && matches.length === 0) return null;

  const unionResult = matches
    ? projectGrepMatches(matches, outputMode, truncated)
    : outputMode === "files_with_matches"
      ? buildGrepFilesResult(grepPaths(lines), truncated)
      : lines.every((line) => isGrepNoise(line))
        ? projectGrepMatches([], outputMode, truncated)
        : null;
  // Unrecognized text goes back as an mcpResult rather than "no matches".
  if (!unionResult) return null;

  return create(GrepResultSchema, {
    result: {
      case: "success",
      value: create(GrepSuccessSchema, {
        pattern,
        path,
        outputMode,
        workspaceResults: {
          [path || "."]: create(GrepUnionResultSchema, { result: unionResult }),
        },
      }),
    },
  });
}

interface OpenCodeGrepMatch {
  file: string;
  lineNumber: number;
  content: string;
}

const GREP_NO_MATCHES = /^(?:No files found|No matches found)$/;
const GREP_SUMMARY = /^Found \d+ matches(?: \(more matches available\))?$/;
const GREP_TRUNCATED = /^\(Results(?: are)? truncated\b/;
const OPENCODE_LINE = /^ {2}Line (\d+): (.*)$/;

function grepLines(content: string): string[] {
  return content.split("\n").map((line) => line.replace(/\r$/, ""));
}

function isGrepNoise(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || GREP_NO_MATCHES.test(trimmed) || GREP_SUMMARY.test(trimmed) || GREP_TRUNCATED.test(trimmed);
}

function isGrepTruncated(lines: readonly string[]): boolean {
  return lines.some(
    (line) => GREP_TRUNCATED.test(line.trim()) || line.includes("more matches available"),
  );
}

/**
 * OpenCode grep records. `null` when the text has no `  Line N:` records;
 * an empty list when those records never follow a `path:` header.
 */
function parseOpenCodeGrep(lines: readonly string[]): OpenCodeGrepMatch[] | null {
  if (!lines.some((line) => OPENCODE_LINE.test(line))) return null;

  const matches: OpenCodeGrepMatch[] = [];
  let currentFile = "";
  for (const line of lines) {
    if (isGrepNoise(line)) continue;
    const match = line.match(OPENCODE_LINE);
    if (match) {
      if (!currentFile) continue;
      matches.push({
        file: currentFile,
        lineNumber: Number.parseInt(match[1]!, 10),
        content: match[2]!,
      });
      continue;
    }
    if (line.endsWith(":") && !line.startsWith(" ")) currentFile = line.slice(0, -1);
  }
  return matches;
}

/** Non-noise lines of a glob listing, in order. */
function grepPaths(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    if (isGrepNoise(line)) return [];
    const path = line.trim();
    return path ? [path] : [];
  });
}

function projectGrepMatches(
  matches: readonly OpenCodeGrepMatch[],
  outputMode: string,
  ripgrepTruncated: boolean,
) {
  if (outputMode === "count") return buildGrepCountResult(matches, ripgrepTruncated);
  if (outputMode === "files_with_matches") return buildGrepFilesResult(uniqueGrepFiles(matches), ripgrepTruncated);
  return buildGrepContentResult(matches, ripgrepTruncated);
}

function uniqueGrepFiles(matches: readonly OpenCodeGrepMatch[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.file)) continue;
    seen.add(match.file);
    files.push(match.file);
  }
  return files;
}

function buildGrepCountResult(matches: readonly OpenCodeGrepMatch[], ripgrepTruncated: boolean) {
  const counts: ReturnType<typeof create<typeof GrepFileCountSchema>>[] = [];
  for (const match of matches) {
    const current = counts.find((entry) => entry.file === match.file);
    if (current) current.count += 1;
    else counts.push(create(GrepFileCountSchema, { file: match.file, count: 1 }));
  }

  return {
    case: "count" as const,
    value: create(GrepCountResultSchema, {
      counts,
      totalFiles: counts.length,
      totalMatches: matches.length,
      clientTruncated: false,
      ripgrepTruncated,
    }),
  };
}

function buildGrepFilesResult(files: readonly string[], ripgrepTruncated: boolean) {
  return {
    case: "files" as const,
    value: create(GrepFilesResultSchema, {
      files: [...files],
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated,
    }),
  };
}

function buildGrepContentResult(matches: readonly OpenCodeGrepMatch[], ripgrepTruncated: boolean) {
  const fileMatches: ReturnType<typeof create<typeof GrepFileMatchSchema>>[] = [];
  let currentFile = "";
  let currentMatches: ReturnType<typeof create<typeof GrepContentMatchSchema>>[] = [];

  const flushFile = () => {
    if (!currentFile || currentMatches.length === 0) return;
    fileMatches.push(create(GrepFileMatchSchema, { file: currentFile, matches: currentMatches }));
    currentMatches = [];
  };

  for (const match of matches) {
    if (match.file !== currentFile) {
      flushFile();
      currentFile = match.file;
    }
    currentMatches.push(create(GrepContentMatchSchema, {
      lineNumber: match.lineNumber,
      content: match.content,
      contentTruncated: false,
      isContextLine: false,
    }));
  }
  flushFile();

  return {
    case: "content" as const,
    value: create(GrepContentResultSchema, {
      matches: fileMatches,
      totalLines: matches.length,
      totalMatchedLines: matches.length,
      clientTruncated: false,
      ripgrepTruncated,
    }),
  };
}
