import { describe, expect, test } from "bun:test";
import { buildLsResult } from "../src/native-tools";
import type { LsDirectoryTreeNode } from "../src/proto/agent_pb";

const ABSOLUTE = ["/home/u/proj/app/a.py", "/home/u/proj/app/sub/b.py"].join("\n");

function tree(content: string, root: string) {
  const result = buildLsResult(content, root);
  expect(result.result.case).toBe("success");
  if (result.result.case !== "success") throw new Error("ls failed");
  return result.result.value.directoryTreeRoot!;
}

function flatten(node: LsDirectoryTreeNode): string[] {
  const dir = node.absPath.endsWith("/") ? node.absPath : `${node.absPath}/`;
  return [
    ...node.childrenFiles.map((file) => `${dir}${file.name}`),
    ...node.childrenDirs.flatMap(flatten),
  ];
}

describe("buildLsResult", () => {
  test("keeps absolute glob paths under an absolute root", () => {
    const root = tree(ABSOLUTE, "/home/u/proj");
    expect(root.absPath).toBe("/home/u/proj");
    expect(root.childrenDirs.map((dir) => dir.absPath)).toEqual(["/home/u/proj/app"]);
    expect(flatten(root)).toEqual(["/home/u/proj/app/a.py", "/home/u/proj/app/sub/b.py"]);
  });

  test.each(["", ".", "app"])("keeps absolute glob paths absolute under root %p", (path) => {
    const root = tree(ABSOLUTE, path);
    expect(root.absPath).toBe("/home/u/proj/app");
    expect(flatten(root)).toEqual(["/home/u/proj/app/a.py", "/home/u/proj/app/sub/b.py"]);
  });

  test("does not duplicate an already-rooted relative path", () => {
    const root = tree(["backend/a.py", "backend/sub/b.py"].join("\n"), "backend");
    expect(flatten(root)).toEqual(["backend/a.py", "backend/sub/b.py"]);
  });

  test("lists the filesystem root without doubled slashes", () => {
    const root = tree(["/a.txt", "/etc/b.conf"].join("\n"), "/");
    expect(root.childrenDirs.map((dir) => dir.absPath)).toEqual(["/etc"]);
    expect(flatten(root)).toEqual(["/a.txt", "/etc/b.conf"]);
  });
});
