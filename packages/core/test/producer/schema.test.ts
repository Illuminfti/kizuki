import { describe, expect, test } from "bun:test";
import {
  MAX_BODY_CHARS,
  MAX_CLAIMS_PER_RESPONSE,
  MAX_OBJECT_CHARS,
  MAX_RESPONSE_CHARS,
  containsVerbatimCapture,
  parseExtractResponse,
} from "../../src/producer/schema";
import { draft, responseText } from "./helpers";

function expectInvalid(text: string, detail: string): void {
  const result = parseExtractResponse(text);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.detail).toContain(detail);
}

describe("strict extraction schema", () => {
  test("a well-formed response parses to drafts", () => {
    const result = parseExtractResponse(responseText([draft()]));
    expect(result).toEqual({ ok: true, claims: [draft()] });
  });

  test("an empty claims list is valid", () => {
    expect(parseExtractResponse('{"claims":[]}')).toEqual({ ok: true, claims: [] });
    expect(parseExtractResponse('  \n{"claims":[]}\n')).toEqual({ ok: true, claims: [] });
  });

  test("one surrounding code fence is tolerated as formatting", () => {
    const text = "```json\n" + responseText([draft()]) + "\n```";
    expect(parseExtractResponse(text)).toEqual({ ok: true, claims: [draft()] });
  });

  test("extra keys are a rejection, not a warning", () => {
    expectInvalid('{"claims":[],"note":"hi"}', "exactly {claims}");
    expectInvalid(
      responseText([{ ...draft(), trusted: "yes" }]),
      "unexpected keys",
    );
    expectInvalid(
      responseText([{ ...draft(), frontmatter: { trusted: true } }]),
      "unexpected keys",
    );
  });

  test("missing keys are a rejection", () => {
    const { sensitivity: _omitted, ...partial } = draft();
    expectInvalid(responseText([partial]), "missing keys");
  });

  test("closed enums reject unknown members without coercion", () => {
    expectInvalid(responseText([draft({ kind: "note" as never })]), "kind");
    expectInvalid(responseText([draft({ polarity: "neutral" as never })]), "polarity");
    expectInvalid(responseText([draft({ sensitivity: "secret" as never })]), "sensitivity");
    expectInvalid(responseText([draft({ sensitivity: "PUBLIC" as never })]), "sensitivity");
  });

  test("bounds are enforced on object, body, confidence and timestamps", () => {
    expectInvalid(
      responseText([draft({ object: "x".repeat(MAX_OBJECT_CHARS + 1) })]),
      "object",
    );
    expectInvalid(
      responseText([draft({ body: "x".repeat(MAX_BODY_CHARS + 1) })]),
      "body",
    );
    expectInvalid(responseText([draft({ body: "" })]), "body");
    expectInvalid(responseText([draft({ confidence: 1.5 })]), "confidence");
    expectInvalid(responseText([draft({ confidence: "0.5" as never })]), "confidence");
    expectInvalid(responseText([draft({ valid_from: "yesterday" })]), "valid_from");
    expectInvalid(responseText([draft({ valid_to: 0 as never })]), "valid_to");
    expect(
      parseExtractResponse(
        responseText([draft({ valid_from: "2026-01-01T00:00:00Z", valid_to: null })]),
      ).ok,
    ).toBe(true);
  });

  test("event_ids must be a non-empty unique bounded list of strings", () => {
    expectInvalid(responseText([draft({ event_ids: [] })]), "event_ids");
    expectInvalid(responseText([draft({ event_ids: ["a", "a"] })]), "event_ids");
    expectInvalid(responseText([draft({ event_ids: [1] as never })]), "event_ids");
    expectInvalid(responseText([draft({ event_ids: "a" as never })]), "event_ids");
  });

  test("non-JSON, non-object, and oversized responses are rejected", () => {
    expectInvalid("Sure! Here are the claims: none.", "not JSON");
    expectInvalid("[]", "not an object");
    expectInvalid("null", "not an object");
    expectInvalid('{"claims":{}}', "not a list");
    expectInvalid("x".repeat(MAX_RESPONSE_CHARS + 1), "size cap");
    expectInvalid(
      responseText(Array.from({ length: MAX_CLAIMS_PER_RESPONSE + 1 }, () => draft())),
      "per-response cap",
    );
  });

  test("a failure names the field and never the offending value", () => {
    const result = parseExtractResponse(
      responseText([draft({ object: "SECRET-VALUE-" + "x".repeat(MAX_OBJECT_CHARS) })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).not.toContain("SECRET-VALUE");
  });

  test("a body that reproduces a long run of quoted text is verbatim capture", () => {
    const source = "The quick brown fox jumps over the lazy dog while the cat watches from the fence and the birds sing above. ".repeat(3);
    expect(containsVerbatimCapture(`Note: ${source.slice(10, 130)} end`, [source])).toBe(true);
    expect(containsVerbatimCapture("Grace leads partnerships at Acme.", [source])).toBe(false);
    expect(containsVerbatimCapture(source.slice(0, 60), [source])).toBe(false);
    expect(containsVerbatimCapture("anything", ["short source"])).toBe(false);
  });
});
