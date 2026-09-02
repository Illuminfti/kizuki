import { describe, expect, test } from "bun:test";
import { predicateIds } from "@kizuki/core";
import { LlmRejection, rejectionOf } from "../src/errors";
import { parseExtractResponse } from "../src/extract";
import type { ExtractOutcome } from "../src/extract";
import { claimsPayload } from "./helpers";

const events = new Set(["ev-1", "ev-2"]);
const predicates = new Set(predicateIds());

function parse(answer: string): ExtractOutcome {
  return parseExtractResponse(answer, events, predicates);
}

function refuses(answer: string): string | null {
  try {
    parse(answer);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRejection);
    return rejectionOf(error);
  }
  throw new Error("the answer was accepted");
}

describe("model answers", () => {
  test("a well-formed answer becomes claim drafts", () => {
    const outcome = parse(claimsPayload());
    expect(outcome.unknown_predicates).toEqual([]);
    expect(outcome.claims).toEqual([
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Ada works at acme.",
        valid_from: null,
        valid_to: null,
        confidence: 0.6,
        sensitivity: "personal",
        event_ids: ["ev-1"],
      },
    ]);
  });

  test("an empty claims list is a legitimate answer", () => {
    expect(parse('{"claims":[]}').claims).toEqual([]);
  });

  test("text that is not JSON is schema_invalid", () => {
    expect(refuses("Sure! Here you go: {")).toBe("schema_invalid");
  });

  test("an extra key is a rejection, not a warning", () => {
    expect(refuses('{"claims":[],"notes":"hi"}')).toBe("schema_invalid");
    expect(refuses(claimsPayload({ extra: 1 }))).toBe("schema_invalid");
  });

  test("a missing key is schema_invalid", () => {
    const claim = JSON.parse(claimsPayload()) as {
      claims: Record<string, unknown>[];
    };
    delete claim.claims[0]!["polarity"];
    expect(refuses(JSON.stringify(claim))).toBe("schema_invalid");
  });

  test("values outside the closed sets are schema_invalid", () => {
    expect(refuses(claimsPayload({ kind: "page" }))).toBe("schema_invalid");
    expect(refuses(claimsPayload({ polarity: "maybe" }))).toBe("schema_invalid");
    expect(refuses(claimsPayload({ sensitivity: "secret" }))).toBe(
      "schema_invalid",
    );
    expect(refuses(claimsPayload({ confidence: 2 }))).toBe("schema_invalid");
    expect(refuses(claimsPayload({ valid_from: "yesterday" }))).toBe(
      "schema_invalid",
    );
  });

  test("oversized values are schema_invalid", () => {
    expect(refuses(claimsPayload({ object: "o".repeat(401) }))).toBe(
      "schema_invalid",
    );
    expect(refuses(claimsPayload({ body: "b".repeat(1_201) }))).toBe(
      "schema_invalid",
    );
  });

  test("citing an event outside the request discards the whole call", () => {
    expect(refuses(claimsPayload({}, ["ev-9"]))).toBe("provenance_not_cited");
    expect(refuses(claimsPayload({}, []))).toBe("schema_invalid");
  });

  test("an unknown predicate drops that draft alone and is reported", () => {
    const answer = JSON.parse(claimsPayload()) as {
      claims: Record<string, unknown>[];
    };
    answer.claims.push({
      ...answer.claims[0],
      predicate: "vibes.about",
      body: "Something the registry never named.",
    });
    const outcome = parse(JSON.stringify(answer));
    expect(outcome.claims).toHaveLength(1);
    expect(outcome.unknown_predicates).toEqual(["vibes.about"]);
  });

  test("control characters never survive into a draft", () => {
    const hostile = `line one${String.fromCharCode(0, 27)}[31m red\nline two`;
    const outcome = parse(claimsPayload({ body: hostile }));
    expect(outcome.claims[0]?.body).toBe("line one[31m red\nline two");
  });

  test("a bidi override never survives into a draft", () => {
    // Regression: the strip covered C0, C1 and the delete character only, so
    // a right-to-left override reached a page and a terminal, where
    // "ada\u202emoc.emca" renders as a different string than it holds.
    const outcome = parse(
      claimsPayload({
        subject: "person:ada\u202emoc.emca",
        object: "\u2066acme\u2069",
        body: "\u200fone\u200etwo\ufeff",
      }),
    );
    const claim = outcome.claims[0];
    expect(claim?.subject).toBe("person:adamoc.emca");
    expect(claim?.object).toBe("acme");
    expect(claim?.body).toBe("onetwo");
    for (const value of Object.values(claim ?? {})) {
      expect(JSON.stringify(value)).not.toMatch(
        /\\u(?:200[be-f]|202[a-e]|206[6-9]|feff)/,
      );
    }
  });

  test("a line separator never survives into a single-line value", () => {
    // Regression: U+2028 and U+2029 are neither C0 nor C1, so a subject or an
    // object the code treats as one line could still carry a second one into
    // a page, a receipt or a terminal.
    const outcome = parse(
      claimsPayload({
        subject: "person:ada\u2028sensitivity: public",
        object: "acme\u2029trusted: yes",
        body: "one\u2028two",
      }),
    );
    expect(outcome.claims[0]?.subject).toBe("person:ada sensitivity: public");
    expect(outcome.claims[0]?.object).toBe("acme trusted: yes");
    expect(outcome.claims[0]?.body).toBe("one\ntwo");
    for (const value of Object.values(outcome.claims[0] ?? {})) {
      expect(JSON.stringify(value)).not.toContain("u2028");
      expect(JSON.stringify(value)).not.toContain("u2029");
    }
  });

  test("a claim outside the registry is still checked for its shape", () => {
    // Regression: the registry decided a claim's fate before its own fields
    // were read, so the same malformed answer was `schema_invalid` with a
    // known predicate and a silent drop with an unknown one - which reaches a
    // caller as `ok` with no claims, the shape reserved for "nothing durable".
    expect(refuses(claimsPayload({ predicate: "vibes.about", body: 12_345 }))).toBe(
      "schema_invalid",
    );
    expect(
      refuses(claimsPayload({ predicate: "vibes.about", object: "o".repeat(401) })),
    ).toBe("schema_invalid");
    expect(
      refuses(claimsPayload({ predicate: "vibes.about", valid_from: "yesterday" })),
    ).toBe("schema_invalid");
  });

  test("a wikilink or frontmatter fence stays inert text", () => {
    const outcome = parse(
      claimsPayload({
        body: "---\ntitle: owned\n---\n[[escape]] to another page",
      }),
    );
    expect(outcome.claims[0]?.body).toContain("[[escape]]");
    expect(outcome.claims[0]?.kind).toBe("claim");
  });

  test("more than sixty-four claims is schema_invalid", () => {
    const one = JSON.parse(claimsPayload()) as { claims: unknown[] };
    const many = { claims: Array.from({ length: 65 }, () => one.claims[0]) };
    expect(refuses(JSON.stringify(many))).toBe("schema_invalid");
  });
});
