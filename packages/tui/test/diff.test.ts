import { describe, expect, test } from "bun:test";
import { diffLines } from "../src/diff";

describe("diffLines", () => {
  test("aligns common lines and marks additions and removals", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });

  test("handles empty sides", () => {
    expect(diffLines("", "x")).toEqual([{ op: "add", text: "x" }]);
    expect(diffLines("x", "")).toEqual([{ op: "del", text: "x" }]);
    expect(diffLines("", "")).toEqual([]);
  });

  test("identical input is all same", () => {
    expect(diffLines("a\nb", "a\nb").every((d) => d.op === "same")).toBe(true);
  });

  test("degrades to remove-all/add-all above the LCS budget", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const other = Array.from({ length: 2500 }, (_, i) => `row ${i}`).join("\n");
    const result = diffLines(big, other);
    expect(result).toHaveLength(5000);
    expect(result[0]?.op).toBe("del");
    expect(result[4999]?.op).toBe("add");
  });
});
