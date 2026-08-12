/**
 * Cursor models emit apply_patch paths relative to the workspace root.
 * OpenCode resolves them against the working directory. Only rewrite a header
 * when the working-directory target is missing and the workspace-root target
 * exists, so a duplicated prefix is fixed without dropping a real component.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const PATCH_HEADERS = [
  "*** Add File: ",
  "*** Delete File: ",
  "*** Update File: ",
  "*** Move to: ",
] as const;

export function rewriteApplyPatchText(
  patchText: string,
  paths: { directory?: string; worktree?: string },
): string {
  const directory = paths.directory;
  const worktree = paths.worktree;
  if (!directory || !worktree) return patchText;
  if (resolve(directory) === resolve(worktree)) return patchText;

  return patchText
    .split("\n")
    .map((line) => {
      for (const header of PATCH_HEADERS) {
        if (!line.startsWith(header)) continue;
        const create = header.startsWith("*** Add File:") || header.startsWith("*** Move to:");
        return header + rewritePatchPath(line.slice(header.length), directory, worktree, create);
      }
      return line;
    })
    .join("\n");
}

function rewritePatchPath(
  filePath: string,
  directory: string,
  worktree: string,
  create: boolean,
): string {
  const given = filePath.trim();
  if (!given) return filePath;

  const cwdPath = resolve(directory, given);
  if (create ? isDirectory(dirname(cwdPath)) : isFile(cwdPath)) return filePath;

  for (const candidate of alternatives(given, cwdPath, directory, worktree)) {
    if (create ? isDirectory(dirname(candidate)) : isFile(candidate)) return candidate;
  }
  return filePath;
}

function alternatives(
  given: string,
  cwdPath: string,
  directory: string,
  worktree: string,
): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const resolved = resolve(value);
    if (resolved !== cwdPath && !out.includes(resolved)) out.push(resolved);
  };

  if (!isAbsolute(given)) {
    add(resolve(worktree, given));
    return out;
  }

  const fromDirectory = relative(directory, given);
  if (fromDirectory && !fromDirectory.startsWith("..") && !isAbsolute(fromDirectory)) {
    add(resolve(worktree, fromDirectory));
  }
  return out;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
