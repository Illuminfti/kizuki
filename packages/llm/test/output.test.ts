import { describe, expect, test } from "bun:test";
import {
  ENTITY_TYPES,
  OUTPUT_LIMITS,
  parseModelJson,
  sanitizeBlock,
  sanitizeLine,
  validateClaims,
  validateEntities,
  validateSummary,
} from "../src/output";

const SUMMARY = { title: "A note", summary: "ada met grace.", confidence: 0.5 };

function entity(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "acme",
    type: "org",
    aliases: ["acme library"],
    evidence: "ada met grace at the acme library",
    confidence: 0.4,
    ...overrides,
  };
}

describe("parseModelJson", () => {
  test("parses a plain object", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("strips one fenced block, labelled or not", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('  ```json\n{"a":1}\n```  ')).toEqual({ a: 1 });
  });

  test.each([
    ["not json at all"],
    ["[1,2,3]"],
    ['"a string"'],
    ["null"],
    ["42"],
    [""],
  ])("returns undefined for %j", (content) => {
    expect(parseModelJson(content)).toBeUndefined();
  });
});

describe("validateSummary", () => {
  test("accepts a well-formed answer and ignores extra keys", () => {
    const result = validateSummary({ ...SUMMARY, thoughts: "ignored" });
    expect(result).toEqual({ ok: true, value: SUMMARY });
  });

  test.each([
    [undefined],
    [[]],
    [{ title: 5, summary: "s", confidence: 0.5 }],
    [{ title: "t", confidence: 0.5 }],
    [{ title: "t", summary: "s", confidence: 1.5 }],
    [{ title: "t", summary: "s", confidence: Number.NaN }],
    [{ title: "t", summary: "s", confidence: "0.5" }],
    [{ title: "t", summary: "s" }],
  ])("refuses %j as a schema failure", (raw) => {
    expect(validateSummary(raw)).toEqual({ ok: false, reason: "schema" });
  });

  test("caps the title and the summary by code points", () => {
    const result = validateSummary({
      title: "t".repeat(5000),
      summary: "s".repeat(5000),
      confidence: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.value.title)).toHaveLength(OUTPUT_LIMITS.title);
    expect(Array.from(result.value.summary)).toHaveLength(
      OUTPUT_LIMITS.summary,
    );
  });

  test("an answer that sanitizes to nothing is empty, not a schema failure", () => {
    expect(
      validateSummary({ title: "   ", summary: "s", confidence: 1 }),
    ).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(validateSummary({ title: "t", summary: "\u0007", confidence: 1 })).toEqual(
      {
        ok: false,
        reason: "empty",
      },
    );
  });
});

describe("validateEntities", () => {
  test("accepts a list and sanitizes every field", () => {
    const result = validateEntities({ entities: [entity()] });
    expect(result).toEqual({
      ok: true,
      value: {
        entities: [
          {
            name: "acme",
            type: "org",
            aliases: ["acme library"],
            evidence: "ada met grace at the acme library",
            confidence: 0.4,
          },
        ],
      },
    });
  });

  test("every documented entity type is accepted", () => {
    for (const type of ENTITY_TYPES) {
      const result = validateEntities({ entities: [entity({ type })] });
      expect(result.ok).toBe(true);
    }
  });

  test("truncates the list to the cap", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      entity({ name: `acme-${index}` }),
    );
    const result = validateEntities({ entities: many });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(OUTPUT_LIMITS.entities);
    expect(result.value.entities[0]?.name).toBe("acme-0");
  });

  test("caps aliases in count and length", () => {
    const result = validateEntities({
      entities: [
        entity({
          aliases: ["a", "b", "c", "d", "e", "f", "g", "x".repeat(200), "  "],
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const aliases = result.value.entities[0]?.aliases ?? [];
    expect(aliases).toHaveLength(OUTPUT_LIMITS.aliases);
    for (const alias of aliases) {
      expect(alias.length).toBeLessThanOrEqual(OUTPUT_LIMITS.alias);
    }
  });

  test("treats a missing alias list as no aliases", () => {
    const { aliases: _dropped, ...rest } = entity();
    const result = validateEntities({ entities: [rest] });
    expect(result.ok && result.value.entities[0]?.aliases).toEqual([]);
  });

  test.each([
    [entity({ type: "spaceship" })],
    [entity({ name: "   " })],
    [entity({ evidence: "" })],
  ])("drops an unusable candidate %#", (candidate) => {
    expect(validateEntities({ entities: [candidate] })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  test("keeps the usable candidates beside a dropped one", () => {
    const result = validateEntities({
      entities: [
        entity({ type: "spaceship" }),
        entity({ name: "grace", type: "person" }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.map((candidate) => candidate.name)).toEqual([
      "grace",
    ]);
  });

  test("an empty list is empty, and a non-list is a schema failure", () => {
    expect(validateEntities({ entities: [] })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(validateEntities({ entities: "acme" })).toEqual({
      ok: false,
      reason: "schema",
    });
    expect(validateEntities({})).toEqual({ ok: false, reason: "schema" });
    expect(validateEntities([entity()])).toEqual({
      ok: false,
      reason: "schema",
    });
  });

  test("a malformed candidate is a schema failure", () => {
    expect(validateEntities({ entities: ["acme"] })).toEqual({
      ok: false,
      reason: "schema",
    });
    expect(validateEntities({ entities: [entity({ confidence: 2 })] })).toEqual(
      {
        ok: false,
        reason: "schema",
      },
    );
  });
});

describe("validateClaims", () => {
  const claim = {
    statement: "ada met grace.",
    subject_id: "person:ada",
    confidence: 0.6,
  };

  test("keeps a subject the record actually carried", () => {
    expect(validateClaims({ claims: [claim] }, ["person:ada"])).toEqual({
      ok: true,
      value: { claims: [claim] },
    });
  });

  test("drops a subject the record never named", () => {
    const result = validateClaims({ claims: [claim] }, ["person:grace"]);
    expect(result.ok && result.value.claims[0]?.subject_id).toBeNull();
  });

  test("accepts an explicit null subject and a missing one", () => {
    const result = validateClaims(
      {
        claims: [
          { ...claim, subject_id: null },
          { statement: "the library is open.", confidence: 0.2 },
        ],
      },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claims.map((atom) => atom.subject_id)).toEqual([
      null,
      null,
    ]);
  });

  test("caps the list and the statement length", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      statement: `${"s".repeat(500)}${index}`,
      subject_id: null,
      confidence: 0.5,
    }));
    const result = validateClaims({ claims: many }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claims).toHaveLength(OUTPUT_LIMITS.claims);
    expect(Array.from(result.value.claims[0]?.statement ?? "")).toHaveLength(
      OUTPUT_LIMITS.statement,
    );
  });

  test("drops a claim that sanitizes to nothing", () => {
    const result = validateClaims(
      { claims: [{ statement: "\u0000\u0001", subject_id: null, confidence: 1 }, claim] },
      ["person:ada"],
    );
    expect(result.ok && result.value.claims).toHaveLength(1);
  });

  test("an empty list is empty and a malformed one is a schema failure", () => {
    expect(validateClaims({ claims: [] }, [])).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      validateClaims({ claims: [{ subject_id: null, confidence: 1 }] }, []),
    ).toEqual({
      ok: false,
      reason: "schema",
    });
    expect(
      validateClaims({ claims: [{ ...claim, subject_id: 7 }] }, []),
    ).toEqual({
      ok: false,
      reason: "schema",
    });
  });
});

describe("sanitizeLine", () => {
  test("strips ansi escapes and other control characters", () => {
    const dirty = "\u001b[31mred\u001b[0m\u0007 text\u0085 and\u009c more";
    const clean = sanitizeLine(dirty, 200);
    expect(clean).not.toContain("\u001b");
    expect(clean).not.toContain("\u0007");
    expect(clean).not.toContain("\u0085");
    expect(clean).not.toContain("\u009c");
    expect(clean).toContain("red");
  });

  test("removes line and paragraph separators", () => {
    expect(sanitizeLine("a\u2028b\u2029c", 200)).toBe("a b c");
  });

  test("collapses whitespace and trims", () => {
    expect(sanitizeLine("  ada    met \t grace \n now  ", 200)).toBe(
      "ada met grace now",
    );
  });

  test("cannot mint a wikilink", () => {
    expect(sanitizeLine("[[Ada]] and [[[Grace]]]", 200)).toBe(
      "[Ada] and [Grace]",
    );
  });

  test("normalizes to NFC", () => {
    expect(sanitizeLine("A\u030A", 200)).toBe("\u00C5");
  });

  test("caps by code points without splitting a surrogate pair", () => {
    const capped = sanitizeLine(`${"a".repeat(4)}\u{1F600}b`, 5);
    expect(Array.from(capped)).toHaveLength(5);
    expect(capped.endsWith("\u{1F600}")).toBe(true);
    expect(capped).not.toContain("�");
  });
});

describe("sanitizeBlock", () => {
  test("keeps newlines and tabs but drops other controls", () => {
    expect(sanitizeBlock("a\n\tb\u0007c", 200)).toBe("a\n\tbc");
  });

  test("normalizes crlf and collapses long newline runs", () => {
    expect(sanitizeBlock("a\r\nb\n\n\n\nc", 200)).toBe("a\nb\n\nc");
  });

  test("cannot mint a wikilink and caps by code points", () => {
    expect(sanitizeBlock("[[Ada]]", 200)).toBe("[Ada]");
    expect(Array.from(sanitizeBlock("x".repeat(500), 10))).toHaveLength(10);
  });
});
