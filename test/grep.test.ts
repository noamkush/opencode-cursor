import { describe, expect, test } from "bun:test";
import { buildGrepResult } from "../src/native-tools";

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
});
