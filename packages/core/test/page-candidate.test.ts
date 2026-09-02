import { describe, expect, test } from "bun:test";
import {
  ENTITY_PAGE_TYPES,
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
  targetProblem,
  validatePageCandidate,
} from "../src/contracts/page-candidate";
import type { PageCandidate } from "../src/contracts/page-candidate";

function candidate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: PAGE_CANDIDATE_SCHEMA,
    type: "person",
    title: "Ada",
    target: "entities/ada",
    extensions: { "x-legacy-path": "people/ada.md" },
    confidence: 1,
    ...overrides,
  };
}

function wrap(raw: unknown): Record<string, unknown> {
  return { [PAGE_CANDIDATE_KEY]: raw };
}

function errorsFor(raw: unknown): string[] {
  const result = validatePageCandidate(wrap(raw));
  if (result === null) throw new Error("expected a present candidate");
  if (result.ok) throw new Error("expected the candidate to be refused");
  return result.errors;
}

describe("validatePageCandidate", () => {
  test("absent key is not an error: the floor keeps its capture note", () => {
    expect(validatePageCandidate({})).toBeNull();
    expect(validatePageCandidate({ relpath: "people/ada.md" })).toBeNull();
  });

  test("accepts a well-formed candidate and returns contract fields only", () => {
    const result = validatePageCandidate(
      wrap({ ...candidate(), smuggled: "ignored" }),
    );
    expect(result?.ok).toBe(true);
    if (result === null || !result.ok) throw new Error("expected acceptance");
    const value: PageCandidate = result.value;
    expect(value).toEqual({
      schema: PAGE_CANDIDATE_SCHEMA,
      type: "person",
      title: "Ada",
      target: "entities/ada",
      extensions: { "x-legacy-path": "people/ada.md" },
      confidence: 1,
    });
  });

  test("refuses a foreign schema tag", () => {
    expect(
      errorsFor(candidate({ schema: "kizuki.page-candidate/v2" })),
    ).toEqual([`schema: must be "${PAGE_CANDIDATE_SCHEMA}"`]);
  });

  test("refuses a type outside the closed page enum", () => {
    expect(errorsFor(candidate({ type: "template" }))[0]).toContain(
      "type: must be one of",
    );
  });

  test("refuses an empty, over-long, or control-charred title", () => {
    expect(errorsFor(candidate({ title: "   " }))).toEqual([
      "title: must be 1..200 characters after trimming",
    ]);
    expect(errorsFor(candidate({ title: "a".repeat(201) }))).toEqual([
      "title: must be 1..200 characters after trimming",
    ]);
    expect(errorsFor(candidate({ title: "Ada\u0007" }))).toEqual([
      "title: must not contain control characters",
    ]);
    expect(errorsFor(candidate({ title: "Ada\u007F" }))).toEqual([
      "title: must not contain control characters",
    ]);
  });

  test("counts a title and an extension string in code points", () => {
    // The importers bound by code points; counting UTF-16 units here would
    // refuse a title of 200 emoji as if it were 400 characters long.
    const emoji = "\u{1F600}";
    const accepts = (raw: unknown): boolean => {
      const result = validatePageCandidate(wrap(raw));
      return result !== null && result.ok;
    };
    expect(accepts(candidate({ title: emoji.repeat(200) }))).toBe(true);
    expect(errorsFor(candidate({ title: emoji.repeat(201) }))).toEqual([
      "title: must be 1..200 characters after trimming",
    ]);
    expect(
      accepts(candidate({ extensions: { "x-a": emoji.repeat(4096) } })),
    ).toBe(true);
    expect(
      errorsFor(candidate({ extensions: { "x-a": emoji.repeat(4097) } })),
    ).toEqual(['extensions: value for "x-a" exceeds 4096 characters']);
    expect(
      errorsFor(candidate({ extensions: { "x-a": [emoji.repeat(4097)] } })),
    ).toEqual(['extensions: value for "x-a" exceeds 4096 characters']);
  });

  test("refuses a traversal target, a deep target, and a long segment", () => {
    expect(
      errorsFor(candidate({ target: "entities/../../etc/passwd" })),
    ).toEqual(['target: unusable path segment ".."']);
    expect(errorsFor(candidate({ target: "a/b/c/d/e/f/g/h/i" }))).toEqual([
      "target: more than 8 path segments",
    ]);
    expect(
      errorsFor(candidate({ target: `entities/${"a".repeat(65)}` }))[0],
    ).toContain("target: unusable path segment");
  });

  test("refuses an extension key outside the x-* namespace", () => {
    expect(errorsFor(candidate({ extensions: { born: 1815 } }))).toEqual([
      'extensions: key "born" must match /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/',
    ]);
    expect(errorsFor(candidate({ extensions: { "x-": 1 } }))).toEqual([
      'extensions: key "x-" must match /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/',
    ]);
  });

  test("refuses a reserved frontmatter key smuggled through extensions", () => {
    for (const reserved of [
      "id",
      "status",
      "sensitivity",
      "sources",
      "type",
      "title",
    ]) {
      expect(
        errorsFor(candidate({ extensions: { [reserved]: "private" } })),
      ).toEqual([
        `extensions: key "${reserved}" is set by the floor, not by a candidate`,
      ]);
    }
  });

  test("bounds the extension bag", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 65; i += 1) many[`x-k${i}`] = "v";
    expect(errorsFor(candidate({ extensions: many }))).toEqual([
      "extensions: must carry at most 64 keys",
    ]);
    expect(
      errorsFor(candidate({ extensions: { "x-a": "a".repeat(4097) } })),
    ).toEqual(['extensions: value for "x-a" exceeds 4096 characters']);
    expect(errorsFor(candidate({ extensions: { "x-a": [1, 2] } }))).toEqual([
      'extensions: value for "x-a" must be a string, finite number, boolean, or string array',
    ]);
    expect(
      errorsFor(candidate({ extensions: { "x-a": new Array(257).fill("v") } })),
    ).toEqual(['extensions: value for "x-a" must hold at most 256 strings']);
  });

  test("refuses a confidence outside [0, 1]", () => {
    expect(errorsFor(candidate({ confidence: 1.5 }))).toEqual([
      "confidence: must be a number in [0, 1]",
    ]);
    expect(errorsFor(candidate({ confidence: "1" }))).toEqual([
      "confidence: must be a number in [0, 1]",
    ]);
  });

  test("refuses a candidate that is not an object at all", () => {
    expect(errorsFor("page")).toEqual([
      "page_candidate: must be a plain object",
    ]);
    expect(errorsFor(null)).toEqual(["page_candidate: must be a plain object"]);
  });

  test("entity types are the subset that files as an entity proposal", () => {
    expect([...ENTITY_PAGE_TYPES]).toEqual([
      "person",
      "org",
      "project",
      "place",
      "topic",
    ]);
  });
});

describe("targetProblem", () => {
  test("null for a usable target, in both separator dialects", () => {
    expect(targetProblem("entities/ada")).toBeNull();
    expect(targetProblem("person:ada")).toBeNull();
    expect(targetProblem("a/b/c/d/e/f/g/h")).toBeNull();
  });

  test("names the rule that fired", () => {
    expect(targetProblem("a/b/c/d/e/f/g/h/i")).toBe(
      "target: more than 8 path segments",
    );
    expect(targetProblem("a/ b")).toBe('target: unusable path segment " b"');
    expect(targetProblem("a//b")).toBe('target: unusable path segment ""');
    expect(targetProblem(`a/${"b".repeat(65)}`)).toBe(
      `target: unusable path segment ${JSON.stringify("b".repeat(65))}`,
    );
  });
});
