import { describe, expect, test } from "bun:test";
import { buildGrepResult } from "../src/native-tools";

const OPENCODE_CONTENT = [
  "Found 3 matches",
  "/tmp/a.ts:",
  "  Line 12: first match",
  "  Line 15: second match",
  "",
  "/tmp/b.ts:",
  "  Line 4: third match",
].join("\n");

function grepArgs(overrides: Record<string, string> = {}) {
  return {
    pattern: "match",
    path: "/tmp",
    outputMode: "content",
    ...overrides,
  };
}

function successUnion(content: string, args?: Record<string, string>) {
  const result = buildGrepResult(content, grepArgs(args));
  expect(result).not.toBeNull();
  expect(result!.result.case).toBe("success");
  const success = result!.result.value;
  const key = (args?.path ?? "/tmp") || ".";
  const union = success!.workspaceResults[key];
  expect(union).toBeDefined();
  return { success: success!, union: union!.result };
}

describe("buildGrepResult", () => {

  test("maps OpenCode ripgrep JSON size abort to a native grep error", () => {
    const result = buildGrepResult(
      "Ripgrep JSON record exceeded 65536 bytes",
      { pattern: "needle", path: ".", outputMode: "content" },
    );
    expect(result).not.toBeNull();
    expect(result!.result.case).toBe("error");
    if (result!.result.case !== "error") return;
    expect(result!.result.value.error).toContain("Ripgrep JSON record exceeded 65536 bytes");
    expect(result!.result.value.error).toContain("Retry with a more specific path or include glob.");
  });
  test("treats OpenCode 'No files found' as empty success", () => {
    const { union } = successUnion("No files found");
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.matches).toEqual([]);
    expect(union.value.totalMatchedLines).toBe(0);
    expect(union.value.clientTruncated).toBe(false);
  });

  test("treats empty output as empty success", () => {
    const { union } = successUnion("");
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.matches).toEqual([]);
  });

  test("parses OpenCode grep content", () => {
    const { union } = successUnion(OPENCODE_CONTENT);
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.totalMatchedLines).toBe(3);
    expect(union.value.totalLines).toBe(3);
    expect(union.value.matches.map((file) => file.file)).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
    expect(union.value.matches[0]!.matches.map((match) => ({
      lineNumber: match.lineNumber,
      content: match.content,
    }))).toEqual([
      { lineNumber: 12, content: "first match" },
      { lineNumber: 15, content: "second match" },
    ]);
    expect(union.value.clientTruncated).toBe(false);
  });

  test("detects OpenCode truncation footer", () => {
    const { union } = successUnion(
      `${OPENCODE_CONTENT}\n\n(Results truncated. Consider using a more specific path or pattern.)`,
    );
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.clientTruncated).toBe(true);
    expect(union.value.totalMatchedLines).toBe(3);
  });

  test("detects 'more matches available' as truncated", () => {
    const { union } = successUnion(OPENCODE_CONTENT.replace("Found 3 matches", "Found 3 matches (more matches available)"));
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.clientTruncated).toBe(true);
  });

  test("does not treat headLimit as truncation", () => {
    const { union } = successUnion(OPENCODE_CONTENT, { headLimit: "50" });
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.clientTruncated).toBe(false);
  });

  test("projects OpenCode content onto files_with_matches", () => {
    const { union } = successUnion(OPENCODE_CONTENT, { outputMode: "files_with_matches" });
    expect(union.case).toBe("files");
    if (union.case !== "files") return;
    expect(union.value.files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
    expect(union.value.totalFiles).toBe(2);
  });

  test("projects OpenCode content onto count", () => {
    const { union } = successUnion(OPENCODE_CONTENT, { outputMode: "count" });
    expect(union.case).toBe("count");
    if (union.case !== "count") return;
    expect(union.value.counts.map((entry) => ({ file: entry.file, count: entry.count }))).toEqual([
      { file: "/tmp/a.ts", count: 2 },
      { file: "/tmp/b.ts", count: 1 },
    ]);
    expect(union.value.totalFiles).toBe(2);
    expect(union.value.totalMatches).toBe(3);
  });

  test("parses glob path lists and skips truncation footers", () => {
    const { union } = successUnion(
      [
        "/tmp/a.ts",
        "/tmp/b.ts",
        "",
        "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)",
      ].join("\n"),
      { outputMode: "files_with_matches" },
    );
    expect(union.case).toBe("files");
    if (union.case !== "files") return;
    expect(union.value.files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
    expect(union.value.clientTruncated).toBe(true);
  });

  test("treats glob 'No files found' as empty files result", () => {
    const { union } = successUnion("No files found", { outputMode: "files_with_matches" });
    expect(union.case).toBe("files");
    if (union.case !== "files") return;
    expect(union.value.files).toEqual([]);
    expect(union.value.totalFiles).toBe(0);
  });

  test("still parses ripgrep file:line:content output", () => {
    const { union } = successUnion(
      ["src/foo.ts:10:match here", "src/foo.ts-11-context line", "src/bar.ts:2:other match"].join("\n"),
    );
    expect(union.case).toBe("content");
    if (union.case !== "content") return;
    expect(union.value.totalMatchedLines).toBe(2);
    expect(union.value.totalLines).toBe(3);
    expect(union.value.matches[0]!.matches[1]!.isContextLine).toBe(true);
    expect(union.value.matches[0]!.matches[1]!.content).toBe("context line");
    expect(union.value.matches[1]!.file).toBe("src/bar.ts");
  });

  test("still parses ripgrep count output", () => {
    const { union } = successUnion(["src/foo.ts:2", "src/bar.ts:5"].join("\n"), { outputMode: "count" });
    expect(union.case).toBe("count");
    if (union.case !== "count") return;
    expect(union.value.totalFiles).toBe(2);
    expect(union.value.totalMatches).toBe(7);
    expect(union.value.counts[0]!).toMatchObject({ file: "src/foo.ts", count: 2 });
  });

  test("returns null for unknown prose instead of claiming no matches", () => {
    expect(buildGrepResult("Permission denied while searching", grepArgs())).toBeNull();
  });

  test("returns null for multiline searches", () => {
    expect(buildGrepResult(OPENCODE_CONTENT, grepArgs({ multiline: "true" }))).toBeNull();
  });
});
