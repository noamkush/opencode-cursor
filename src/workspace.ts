/**
 * Cursor's agent is told where the workspace is through RequestContext.env,
 * and its native tools report absolute paths. Without that root, the model
 * guesses which directory relative paths belong to. The plugin passes the
 * session directory alongside each request so the proxy can supply it.
 */
import { create } from "@bufbuild/protobuf";
import { platform, release } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { RequestContextEnvSchema, type RequestContextEnv } from "./proto/agent_pb";
import {
  REQUEST_CONTEXT_ENV_PROCESS_WORKING_DIRECTORY_FIELD,
  unknownStringField,
} from "./unknown-fields";

export const WORKSPACE_DIRECTORY_HEADER = "x-opencode-cursor-directory";

/** Header values must be ASCII; directories need not be. */
export function encodeWorkspaceDirectory(directory: string): string {
  return encodeURIComponent(directory);
}

/** The absolute workspace directory, or `undefined` when missing or malformed. */
export function decodeWorkspaceDirectory(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const directory = decodeURIComponent(value);
    return isAbsolute(directory) ? directory : undefined;
  } catch {
    return undefined;
  }
}

export function withWorkspaceDirectory(request: Request, directory: string): Request {
  const headers = new Headers(request.headers);
  headers.set(WORKSPACE_DIRECTORY_HEADER, encodeWorkspaceDirectory(directory));
  return new Request(request, { headers });
}

/** Resolve a native tool path the way OpenCode does, against the session directory. */
export function resolveWorkspacePath(path: string, directory: string | undefined): string | undefined {
  if (!directory) return isAbsolute(path) ? path : undefined;
  return resolve(directory, path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

/** Cursor's shell names, as its own client reports them. */
function shellName(shell: string): string {
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("pwsh") || shell.includes("powershell")) return "powershell";
  return "naive";
}

/** RequestContext.env as Cursor's local client builds it, minus Cursor-only folders. */
export function buildRequestContextEnv(directory: string | undefined): RequestContextEnv {
  let timeZone = "";
  try {
    timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {}
  const env = create(RequestContextEnvSchema, {
    osVersion: `${platform()} ${release()}`,
    workspacePaths: directory ? [directory] : [],
    shell: shellName(process.env.SHELL ?? ""),
    timeZone,
  });
  if (directory) {
    env.$unknown = [unknownStringField(REQUEST_CONTEXT_ENV_PROCESS_WORKING_DIRECTORY_FIELD, directory)];
  }
  return env;
}
