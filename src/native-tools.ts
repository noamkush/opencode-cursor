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
  FetchResultSchema,
  FetchSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepCountResultSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type ExecServerMessage,
  type LsDirectoryTreeNode,
  type McpToolDefinition,
} from "./proto/agent_pb";

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
 * Convert OpenCode Read output to plain file content. Unwraps one
 * `<path>`, `<type>file</type>`, `<content>` envelope, strips numbered
 * prefixes from the inner lines, and drops the Read footer unless
 * `keepFooter` is set. The footer is the only sign that a read stopped
 * early, so results shown to the model should keep it.
 */
export function unwrapReadOutput(
  text: string,
  options: { keepFooter?: boolean } = {},
): string {
  const match = text.match(FILE_ENVELOPE);
  if (!match) return text;
  const inner = match[1]!;
  const footer = inner.match(READ_FOOTER);
  const content = stripReadLinePrefixes(footer ? inner.slice(0, footer.index) : inner);
  return options.keepFooter && footer ? content + footer[0] : content;
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
    const key = filePathKey(mcpTools.find((tool) => (tool.name || tool.toolName) === toolName));
    if (!key) return null;
    return {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify({ [key]: args.path ?? "" }),
      binding: { resultType: "readResult", args: { path: args.path ?? "" } },
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
          ...(args.headLimit != null ? { headLimit: String(args.headLimit) } : undefined),
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
      sendExec(
        "readResult",
        create(ReadResultSchema, {
          result: {
            case: "success",
            value: create(ReadSuccessSchema, {
              path: args.path ?? "",
              totalLines: text.split("\n").length,
              fileSize: BigInt(new TextEncoder().encode(text).byteLength),
              truncated: false,
              output: { case: "content", value: text },
            }),
          },
        }),
      );
      return true;
    }

    case "writeResult": {
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
      sendExec(
        "shellResult",
        create(ShellResultSchema, {
          result: {
            case: "success",
            value: create(ShellSuccessSchema, {
              command: args.command ?? "",
              workingDirectory: args.workingDirectory ?? "",
              exitCode: 0,
              signal: "",
              stdout: text,
              stderr: "",
            }),
          },
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
        sendExec(
          "shellStream",
          create(ShellStreamSchema, {
            event: {
              case: "stdout",
              value: create(ShellStreamStdoutSchema, { data: text }),
            },
          }),
        );
      }
      sendExec(
        "shellStream",
        create(ShellStreamSchema, {
          event: { case: "exit", value: create(ShellStreamExitSchema, { code: 0 }) },
        }),
      );
      return true;
    }

    case "lsResult": {
      const built = buildLsResult(text, args.path ?? "");
      if (!built) return false;
      sendExec("lsResult", built);
      return true;
    }

    case "grepResult": {
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

/** Parse the client grep tool's text output back into Cursor's structured result. */
function buildGrepResult(content: string, args: Record<string, string>) {
  const pattern = args.pattern ?? "";
  const path = args.path ?? "";
  const outputMode = args.outputMode || "content";

  if (args.multiline === "true") return null;
  if (!["content", "files_with_matches", "count"].includes(outputMode)) {
    return null;
  }

  const unionResult =
    outputMode === "count"
      ? buildGrepCountResult(content, Boolean(args.headLimit))
      : outputMode === "files_with_matches"
        ? buildGrepFilesResult(content, Boolean(args.headLimit))
        : buildGrepContentResult(content, Boolean(args.headLimit));

  // Non-empty tool output that we failed to parse: better to hand the raw
  // text back as an mcpResult than to claim "no matches".
  if (content.trim() && isEmptyGrepUnion(unionResult)) return null;

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

function buildGrepCountResult(content: string, clientTruncated: boolean) {
  const counts: ReturnType<typeof create<typeof GrepFileCountSchema>>[] = [];
  let totalMatches = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const separator = line.lastIndexOf(":");
    if (separator === -1) continue;
    const tail = line.slice(separator + 1);
    if (!/^\d+$/.test(tail)) continue;
    const file = line.slice(0, separator);
    const count = Number.parseInt(tail, 10);
    counts.push(create(GrepFileCountSchema, { file, count }));
    totalMatches += count;
  }

  return {
    case: "count" as const,
    value: create(GrepCountResultSchema, {
      counts,
      totalFiles: counts.length,
      totalMatches,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function buildGrepFilesResult(content: string, clientTruncated: boolean) {
  const files = content
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean);

  return {
    case: "files" as const,
    value: create(GrepFilesResultSchema, {
      files,
      totalFiles: files.length,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function buildGrepContentResult(content: string, clientTruncated: boolean) {
  const fileMatches: ReturnType<typeof create<typeof GrepFileMatchSchema>>[] = [];
  let currentFile = "";
  let currentMatches: ReturnType<typeof create<typeof GrepContentMatchSchema>>[] = [];
  let totalLines = 0;
  let totalMatchedLines = 0;

  const flushFile = () => {
    if (currentFile && currentMatches.length > 0) {
      fileMatches.push(
        create(GrepFileMatchSchema, { file: currentFile, matches: currentMatches }),
      );
    }
    currentMatches = [];
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "--" || line === "") continue;

    const matchLine = line.match(/^(.+?):(\d+):(.*)/);
    if (matchLine) {
      const file = matchLine[1]!;
      if (file !== currentFile) {
        flushFile();
        currentFile = file;
      }
      totalLines += 1;
      totalMatchedLines += 1;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber: Number.parseInt(matchLine[2]!, 10),
          content: matchLine[3]!,
          contentTruncated: false,
          isContextLine: false,
        }),
      );
      continue;
    }

    const contextLine = parseGrepContextLine(line, currentFile);
    if (!contextLine) continue;
    if (contextLine.file !== currentFile) {
      flushFile();
      currentFile = contextLine.file;
    }
    totalLines += 1;
    currentMatches.push(
      create(GrepContentMatchSchema, {
        lineNumber: contextLine.lineNumber,
        content: contextLine.content,
        contentTruncated: false,
        isContextLine: true,
      }),
    );
  }

  flushFile();

  return {
    case: "content" as const,
    value: create(GrepContentResultSchema, {
      matches: fileMatches,
      totalLines,
      totalMatchedLines,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function parseGrepContextLine(line: string, currentFile: string) {
  if (currentFile) {
    const prefix = `${currentFile}-`;
    if (line.startsWith(prefix)) {
      const match = line.slice(prefix.length).match(/^(\d+)-(.*)$/s);
      if (match) {
        return {
          file: currentFile,
          lineNumber: Number.parseInt(match[1]!, 10),
          content: match[2]!,
        };
      }
    }
  }

  const fallback = line.match(/^(.+?)-(\d+)-(.*)$/);
  if (!fallback) return null;
  return {
    file: fallback[1]!,
    lineNumber: Number.parseInt(fallback[2]!, 10),
    content: fallback[3]!,
  };
}

function isEmptyGrepUnion(
  result:
    | ReturnType<typeof buildGrepCountResult>
    | ReturnType<typeof buildGrepFilesResult>
    | ReturnType<typeof buildGrepContentResult>,
): boolean {
  if (result.case === "count") return result.value.counts.length === 0;
  if (result.case === "files") return result.value.files.length === 0;
  return result.value.matches.length === 0;
}
