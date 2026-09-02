import { describe, expect, test } from "bun:test";
import { targetProblem } from "@kizuki/core";
import {
  matchesGlob,
  parseLegacyTimestamp,
  sanitizeLine,
  slug,
  subjectId,
  toFrontmatterValue,
} from "../src/legacy/coerce";

describe("sanitizeLine", () => {
  test("collapses whitespace and trims", () => {
    expect(sanitizeLine("  Ada   Lovelace \n", 200)).toBe("Ada Lovelace");
  });

  test("control characters become word boundaries, never escape sequences", () => {
    expect(sanitizeLine("Ada\u001B[31mred", 200)).toBe("Ada [31mred");
    expect(sanitizeLine("a\u0000b\u007Fc", 200)).toBe("a b c");
  });

  test("truncates by code points, not by UTF-16 units", () => {
    expect(sanitizeLine("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe(
      "\u{1F600}\u{1F600}",
    );
    expect(sanitizeLine("abcdef", 3)).toBe("abc");
  });
});

describe("slug", () => {
  test("produces a path segment for every input", () => {
    const cases = [
      "Ada Lovelace",
      "  --leading",
      "...",
      "",
      "Ünïcödé Näme",
      "a/b/c",
      "2026-01-01",
      "!!!",
      "___under",
      "MiXeD.Case_v2",
      "\u{1F600} emoji",
    ];
    for (const value of cases) {
      const result = slug(value);
      expect(result.length).toBeGreaterThan(0);
      expect(targetProblem(result)).toBeNull();
    }
  });

  test("lowercases, folds runs of punctuation, and keeps dots and dashes", () => {
    expect(slug("Ada Lovelace")).toBe("ada-lovelace");
    expect(slug("MiXeD.Case_v2")).toBe("mixed.case_v2");
    expect(slug("a  //  b")).toBe("a-b");
  });

  test("strips leading non-alphanumerics and empty results become a page", () => {
    expect(slug("___under")).toBe("under");
    expect(slug("...")).toBe("page");
    expect(slug("")).toBe("page");
    expect(slug("!!!")).toBe("page");
  });

  test("truncates to the requested length", () => {
    expect(slug("a".repeat(100))).toBe("a".repeat(64));
    expect(slug("abcdef", 3)).toBe("abc");
  });
});

describe("subjectId", () => {
  test("namespaces and lowercases", () => {
    expect(subjectId("legacy", "Ada Lovelace")).toBe("legacy:ada lovelace");
  });

  test("strips wiki link brackets and the alias suffix", () => {
    expect(subjectId("legacy", "[[Ada]]")).toBe("legacy:ada");
    expect(subjectId("legacy", "[[Ada|Ada L.]]")).toBe("legacy:ada");
    expect(subjectId("legacy", "Grace|display")).toBe("legacy:grace");
  });

  test("null when nothing is left to identify", () => {
    expect(subjectId("legacy", "[[]]")).toBeNull();
    expect(subjectId("legacy", "   ")).toBeNull();
    expect(subjectId("legacy", "|alias")).toBeNull();
  });
});

describe("toFrontmatterValue", () => {
  test("keeps what the vault can already serialize", () => {
    expect(toFrontmatterValue("plain")).toEqual({
      ok: true,
      value: "plain",
      note: "kept",
    });
    expect(toFrontmatterValue(1815)).toEqual({
      ok: true,
      value: 1815,
      note: "kept",
    });
    expect(toFrontmatterValue(true)).toEqual({
      ok: true,
      value: true,
      note: "kept",
    });
    expect(toFrontmatterValue(["a", "b"])).toEqual({
      ok: true,
      value: ["a", "b"],
      note: "kept",
    });
  });

  test("stringifies mixed scalar arrays", () => {
    expect(toFrontmatterValue([1, true, "x"])).toEqual({
      ok: true,
      value: ["1", "true", "x"],
      note: "array_stringified",
    });
  });

  test("json-stringifies nested structures and plain objects", () => {
    expect(toFrontmatterValue({ home: "acme" })).toEqual({
      ok: true,
      value: '{"home":"acme"}',
      note: "json_stringified",
    });
    expect(toFrontmatterValue([["a"]])).toEqual({
      ok: true,
      value: '[["a"]]',
      note: "json_stringified",
    });
  });

  test("truncates over-long strings, arrays, and serialized structures", () => {
    const long = toFrontmatterValue("a".repeat(5000));
    expect(long).toEqual({
      ok: true,
      value: "a".repeat(4096),
      note: "truncated",
    });
    const many = toFrontmatterValue(new Array(300).fill("v"));
    if (!many.ok || !Array.isArray(many.value))
      throw new Error("expected an array");
    expect(many.value).toHaveLength(256);
    expect(many.note).toBe("truncated");
    const deep = toFrontmatterValue({ blob: "a".repeat(6000) });
    expect(deep.ok && deep.note).toBe("truncated");
  });

  test("reports what cannot be represented at all", () => {
    expect(toFrontmatterValue(null)).toEqual({ ok: false, reason: "null" });
    expect(toFrontmatterValue(undefined)).toEqual({
      ok: false,
      reason: "null",
    });
    expect(toFrontmatterValue([])).toEqual({
      ok: false,
      reason: "empty_array",
    });
    expect(toFrontmatterValue(Number.NaN)).toEqual({
      ok: false,
      reason: "unrepresentable",
    });
    expect(toFrontmatterValue(10n)).toEqual({
      ok: false,
      reason: "unrepresentable",
    });
  });
});

describe("parseLegacyTimestamp", () => {
  test("accepts each format it advertises", () => {
    expect(parseLegacyTimestamp("2026-01-01T00:00:00Z", "rfc3339")).toBe(
      "2026-01-01T00:00:00Z",
    );
    expect(parseLegacyTimestamp("2026-01-01 10:30:00", "sqlite_datetime")).toBe(
      "2026-01-01T10:30:00Z",
    );
    expect(parseLegacyTimestamp("2026-01-01", "date")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseLegacyTimestamp(1_767_225_600, "unix_seconds")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseLegacyTimestamp("1767225600", "unix_seconds")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseLegacyTimestamp(1_767_225_600_000, "unix_millis")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseLegacyTimestamp("2026-01-01T00:00:00Z", "js_date")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  test("null rather than a guess, and never a throw", () => {
    expect(parseLegacyTimestamp("soon", "rfc3339")).toBeNull();
    expect(parseLegacyTimestamp("2026-02-30", "date")).toBeNull();
    expect(parseLegacyTimestamp("2026-01-01", "sqlite_datetime")).toBeNull();
    expect(parseLegacyTimestamp("later", "unix_seconds")).toBeNull();
    expect(parseLegacyTimestamp(Number.NaN, "unix_millis")).toBeNull();
    expect(parseLegacyTimestamp({ ts: 1 }, "js_date")).toBeNull();
    expect(parseLegacyTimestamp(null, "rfc3339")).toBeNull();
    expect(parseLegacyTimestamp(1e30, "unix_seconds")).toBeNull();
  });

  test("a date field is not silently accepted in another format's slot", () => {
    expect(parseLegacyTimestamp("2026-01-01", "rfc3339")).toBeNull();
  });
});

describe("matchesGlob", () => {
  test("a single star stays inside one segment", () => {
    expect(matchesGlob("plan.md", "*.md")).toBe(true);
    expect(matchesGlob("notes/plan.md", "*.md")).toBe(false);
    expect(matchesGlob("notes/plan.md", "notes/*.md")).toBe(true);
  });

  test("a double star spans segments, including none", () => {
    expect(matchesGlob("templates/person.md", "templates/**")).toBe(true);
    expect(matchesGlob("templates/a/b/c.md", "templates/**")).toBe(true);
    expect(matchesGlob("plan.md", "**/*.md")).toBe(true);
    expect(matchesGlob("a/b/plan.md", "**/*.md")).toBe(true);
  });

  test("a question mark is exactly one non-separator character", () => {
    expect(matchesGlob("a.md", "?.md")).toBe(true);
    expect(matchesGlob("ab.md", "?.md")).toBe(false);
    expect(matchesGlob("a/b", "a?b")).toBe(false);
  });

  test("the pattern is anchored at both ends", () => {
    expect(matchesGlob("drafts/x.md", "drafts")).toBe(false);
    expect(matchesGlob("my-drafts/x.md", "drafts/**")).toBe(false);
  });

  test("regex and backslash characters are literal, not operators", () => {
    expect(matchesGlob("a.md", "a.md")).toBe(true);
    expect(matchesGlob("axmd", "a.md")).toBe(false);
    expect(matchesGlob("a+b.md", "a+b.md")).toBe(true);
    expect(matchesGlob("a\\b", "a\\b")).toBe(true);
    expect(matchesGlob("a/b", "a\\b")).toBe(false);
    expect(matchesGlob("(x)", "(x)")).toBe(true);
  });
});
