import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { rewriteApplyPatchText } from "../src/patch-paths";

function patch(headers: string[]): string {
  return ["*** Begin Patch", ...headers, "*** End Patch"].join("\n");
}

function nestedRepo() {
  const worktree = mkdtempSync(join(tmpdir(), "opencode-cursor-patch-"));
  const directory = join(worktree, "packages", "opencode");
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "foo.ts"), "a\n");
  writeFileSync(join(directory, "obsolete.ts"), "x\n");
  return { directory, worktree };
}

describe("rewriteApplyPatchText", () => {
  test("rewrites a workspace-relative update to the file that exists", () => {
    const paths = nestedRepo();
    const input = patch(["*** Update File: packages/opencode/src/foo.ts"]);
    expect(rewriteApplyPatchText(input, paths)).toBe(
      patch([`*** Update File: ${join(paths.directory, "src", "foo.ts")}`]),
    );
  });

  test("does not drop a cwd-relative component that happens to match the prefix", () => {
    const paths = nestedRepo();
    mkdirSync(join(paths.directory, "packages", "opencode", "src"), { recursive: true });
    writeFileSync(join(paths.directory, "packages", "opencode", "src", "foo.ts"), "nested\n");
    const input = patch(["*** Update File: packages/opencode/src/foo.ts"]);
    expect(rewriteApplyPatchText(input, paths)).toBe(input);
  });

  test("leaves already cwd-relative paths unchanged", () => {
    const paths = nestedRepo();
    const input = patch(["*** Update File: src/foo.ts"]);
    expect(rewriteApplyPatchText(input, paths)).toBe(input);
  });

  test("is a no-op when directory equals worktree", () => {
    const paths = nestedRepo();
    const input = patch(["*** Update File: packages/opencode/src/foo.ts"]);
    expect(
      rewriteApplyPatchText(input, { directory: paths.worktree, worktree: paths.worktree }),
    ).toBe(input);
  });

  test("rewrites a duplicated absolute path under the working directory", () => {
    const paths = nestedRepo();
    const input = patch([
      `*** Update File: ${join(paths.directory, "packages", "opencode", "src", "foo.ts")}`,
    ]);
    expect(rewriteApplyPatchText(input, paths)).toBe(
      patch([`*** Update File: ${join(paths.directory, "src", "foo.ts")}`]),
    );
  });

  test("leaves a correct absolute working-directory path unchanged", () => {
    const paths = nestedRepo();
    const input = patch([`*** Update File: ${join(paths.directory, "src", "foo.ts")}`]);
    expect(rewriteApplyPatchText(input, paths)).toBe(input);
  });

  test("rewrites add/move when only the workspace parent exists", () => {
    const paths = nestedRepo();
    const input = patch([
      "*** Add File: packages/opencode/src/bar.ts",
      "*** Move to: packages/opencode/src/baz.ts",
      "*** Delete File: packages/opencode/obsolete.ts",
    ]);
    expect(rewriteApplyPatchText(input, paths)).toBe(
      patch([
        `*** Add File: ${join(paths.directory, "src", "bar.ts")}`,
        `*** Move to: ${join(paths.directory, "src", "baz.ts")}`,
        `*** Delete File: ${join(paths.directory, "obsolete.ts")}`,
      ]),
    );
  });

  test("leaves missing files unchanged", () => {
    const paths = nestedRepo();
    const input = patch(["*** Update File: packages/opencode/missing.ts"]);
    expect(rewriteApplyPatchText(input, paths)).toBe(input);
  });

  test("is a no-op when directory or worktree is missing", () => {
    const input = patch(["*** Update File: packages/opencode/src/foo.ts"]);
    expect(rewriteApplyPatchText(input, {})).toBe(input);
    expect(rewriteApplyPatchText(input, { directory: "/repo/packages/opencode" })).toBe(
      input,
    );
    expect(rewriteApplyPatchText(input, { worktree: "/repo" })).toBe(input);
  });
});
