import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as conceptCard from "../../src/contracts/concept-card";
import * as situationCard from "../../src/contracts/situation-card";
import { QUESTION_CARD_SCHEMA, validateQuestionCard, type QuestionCard } from "../helpers/question-card";

const token = (seed: number) => Buffer.alloc(32, seed).toString("base64url");
const ref = <K extends string>(kind: K, seed: number) => ({ kind, token: token(seed) });

const relation = (seed: number) => ({
  schema: "kizuki.relation/v1" as const,
  claim: ref("claim", seed),
  subject: ref("object", 1),
  predicate: "question.candidate_answer",
  object: { kind: "literal" as const, value: "Doing it twice equals doing it once" },
  perspective: {
    holder: null,
    speaker: null,
    addressee: null,
    mode: "asserted" as const,
    interpretation: "explicit" as const,
    evidence: [{ admission: ref("admission", seed), eventVersion: ref("event_version", seed), span: { kind: "text" as const, startUtf16: 0, endUtf16: 5 } }],
  },
  context: [],
  polarity: "positive" as const,
  valid: { kind: "known" as const, from: "2026-01-01T00:00:00.000Z", until: null },
  temporalBasis: "explicit" as const,
  assessments: [],
  conflict: "unknown" as const,
});

function card(over: Record<string, unknown> = {}): QuestionCard {
  return {
    schema: QUESTION_CARD_SCHEMA,
    question: {
      schema: "kizuki.knowledge-node/v1",
      ref: ref("object", 1),
      kind: "question",
      classificationClaims: [ref("claim", 2)],
      labels: [{ text: "What is idempotency?", claim: ref("claim", 3) }],
      resolution: "distinct",
    },
    summary: null,
    text: relation(4),
    answers: [relation(5)],
    knownAt: { kind: "current" },
    coverage: { status: "complete_for_query", gaps: [], validWindow: { kind: "all" }, history: "unavailable" },
    ...over,
  } as QuestionCard;
}

const REFUSED = { ok: false, errors: ["invalid question-card/v1 payload"] } as const;

describe("a card codec built from the kit", () => {
  test("accepts a well-formed card and hands back the snapshot it validated", () => {
    const input = card();
    const result = validateQuestionCard(input);
    expect(result).toEqual({ ok: true, value: input });
    expect(result.ok && result.value).not.toBe(input);
  });

  test("rejects extra keys on the card and on every nested shape", () => {
    expect(validateQuestionCard({ ...card(), extra: 1 })).toEqual(REFUSED);
    const { question } = card();
    expect(validateQuestionCard(card({ question: { ...question, extra: 1 } }))).toEqual(REFUSED);
    expect(validateQuestionCard(card({ answers: [{ ...relation(5), extra: 1 }] }))).toEqual(REFUSED);
    expect(validateQuestionCard(card({ coverage: { ...card().coverage, extra: 1 } }))).toEqual(REFUSED);
  });

  test("rejects a missing key, a wrong schema and input that is not an object", () => {
    const { knownAt: _dropped, ...rest } = card();
    expect(validateQuestionCard(rest)).toEqual(REFUSED);
    expect(validateQuestionCard(card({ schema: "kizuki.question-card/v2" }))).toEqual(REFUSED);
    for (const input of [null, undefined, "card", 7, [card()]]) expect(validateQuestionCard(input)).toEqual(REFUSED);
  });

  test("rejects bad references: short, wrong kind, extra keys and a node ref of the wrong kind of thing", () => {
    for (const bad of [
      { kind: "object", token: "short" },
      { kind: "claim", token: token(9) },
      { kind: "object", token: token(9), extra: true },
      { kind: "object", token: `${token(9)}=` },
      "not a ref",
    ]) {
      expect(validateQuestionCard(card({ question: { ...card().question, ref: bad } }))).toEqual(REFUSED);
    }
    expect(validateQuestionCard(card({ question: { ...card().question, kind: "concept" } }))).toEqual(REFUSED);
  });

  test("rejects oversize arrays at their bound and accepts the bound itself", () => {
    const labels = (count: number) => Array.from({ length: count }, (_, at) => ({ text: `Label ${at}`, claim: ref("claim", 3) }));
    const withLabels = (count: number) => card({ question: { ...card().question, labels: labels(count) } });
    expect(validateQuestionCard(withLabels(256)).ok).toBe(true);
    expect(validateQuestionCard(withLabels(257))).toEqual(REFUSED);
    expect(validateQuestionCard(card({ answers: Array.from({ length: 257 }, () => relation(5)) }))).toEqual(REFUSED);
    expect(validateQuestionCard(card({ coverage: { ...card().coverage, gaps: Array(17).fill("coverage") } }))).toEqual(REFUSED);
  });

  test("rejects a value a field's own rule refuses", () => {
    const bad = (over: object) => card({ answers: [{ ...relation(5), ...over }] });
    expect(validateQuestionCard(bad({ polarity: "maybe" }))).toEqual(REFUSED);
    expect(validateQuestionCard(bad({ predicate: "has space" }))).toEqual(REFUSED);
    expect(validateQuestionCard(bad({ valid: { kind: "known", from: "2026-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" } }))).toEqual(REFUSED);
    expect(validateQuestionCard(bad({ object: { kind: "literal", value: "" } }))).toEqual(REFUSED);
    expect(validateQuestionCard(card({ coverage: { ...card().coverage, gaps: ["invented"] } }))).toEqual(REFUSED);
  });

  test("turns a hostile input into the same refusal instead of throwing", () => {
    const hostile = card();
    Object.defineProperty(hostile, "answers", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(validateQuestionCard(hostile)).toEqual(REFUSED);
  });

  test("costs under a hundred lines, shape and assembler included", () => {
    const lines = readFileSync(join(import.meta.dir, "../helpers/question-card.ts"), "utf8").trimEnd().split("\n").length;
    expect(lines).toBeLessThan(100);
  });
});

describe("the shipped card modules", () => {
  test("publish the same runtime names as before the kit", () => {
    expect(Object.keys(conceptCard).sort()).toEqual([
      "CONCEPT_CARD_SCHEMA",
      "KNOWLEDGE_NODE_SCHEMA",
      "RELATION_SCHEMA",
      "validateConceptCard",
    ]);
    expect(Object.keys(situationCard).sort()).toEqual([
      "SITUATION_CARD_SCHEMA",
      "SITUATION_NODE_SCHEMA",
      "SITUATION_RELATION_SCHEMA",
      "validateSituationCard",
    ]);
  });
});
