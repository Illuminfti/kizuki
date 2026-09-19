import { expect, test } from "bun:test";
import {
  CONCEPT_CARD_SCHEMA,
  validateConceptCard,
} from "../../src/contracts/concept-card";

const AT = "2026-01-02T00:00:00.000Z";
const FROM = "2026-01-01T00:00:00.000Z";

function token(fill: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, () => fill)).toString(
    "base64url",
  );
}

const OBJECT = token(1);
const CLAIM = token(2);
const ADMISSION = token(3);
const EVENT_VERSION = token(4);
const SNAPSHOT = token(5);

function ref(kind: string, value: string): { kind: string; token: string } {
  return { kind, token: value };
}

function evidence() {
  return {
    admission: ref("admission", ADMISSION),
    eventVersion: ref("event_version", EVENT_VERSION),
    span: { kind: "text", startUtf16: 0, endUtf16: 12 },
  };
}

function relation(predicate = "concept.definition") {
  return {
    schema: "kizuki.relation/v1",
    claim: ref("claim", CLAIM),
    subject: ref("object", OBJECT),
    predicate,
    object: { kind: "literal", value: "a bounded concept" },
    perspective: {
      holder: null,
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      evidence: [evidence()],
    },
    context: [],
    polarity: "positive",
    valid: { kind: "known", from: FROM, until: null },
    temporalBasis: "explicit",
    assessments: [
      {
        admission: ref("admission", ADMISSION),
        epistemicKind: "observed",
        authority: "connector_evidence",
        confidence: { kind: "known", value: 0.8 },
        independence: "independent",
        evidence: [evidence()],
      },
    ],
    conflict: "none_observed",
  };
}

function card(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: CONCEPT_CARD_SCHEMA,
    concept: {
      schema: "kizuki.knowledge-node/v1",
      ref: ref("object", OBJECT),
      kind: "concept",
      classificationClaims: [ref("claim", CLAIM)],
      labels: [{ text: "grace", claim: ref("claim", CLAIM) }],
      resolution: "distinct",
    },
    summary: {
      text: "Grace is the named concept under test.",
      admissions: [ref("admission", ADMISSION)],
    },
    definitions: [relation()],
    relations: [],
    learning: [],
    knownAt: { kind: "current" },
    coverage: {
      status: "complete_for_query",
      gaps: [],
      validWindow: { kind: "all" },
      history: "retained_for_query",
    },
    ...overrides,
  };
}

test("locks the accepted concept-card schema", () => {
  expect(CONCEPT_CARD_SCHEMA).toBe("kizuki.concept-card/v1");
});

test("a closed concept card round-trips through the validator", () => {
  const result = validateConceptCard(card());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.schema).toBe(CONCEPT_CARD_SCHEMA);
  expect(result.value.concept.kind).toBe("concept");
  expect(result.value.definitions).toHaveLength(1);
});

test("unknown extra keys are refused", () => {
  expect(validateConceptCard(card({ writer: "no" })).ok).toBe(false);
});

test("a malformed wire token is refused", () => {
  expect(
    validateConceptCard(
      card({
        knownAt: { kind: "snapshot", ref: ref("snapshot", "not-a-token") },
      }),
    ).ok,
  ).toBe(false);
});

test("overlap validity must end after it starts", () => {
  expect(
    validateConceptCard(
      card({
        coverage: {
          status: "partial",
          gaps: ["coverage"],
          validWindow: { kind: "overlap", from: AT, until: AT },
          history: "baseline_only",
        },
      }),
    ).ok,
  ).toBe(false);
});

test("an unknown learning facet is refused", () => {
  expect(
    validateConceptCard(
      card({
        learning: [
          {
            facet: "mastery",
            assertion: relation("learning.application"),
            assistance: "unknown",
            assistanceEvidence: [],
          },
        ],
      }),
    ).ok,
  ).toBe(false);
});

test("a snapshot knownAt is accepted", () => {
  const result = validateConceptCard(
    card({
      summary: null,
      knownAt: { kind: "snapshot", ref: ref("snapshot", SNAPSHOT) },
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.summary).toBeNull();
  expect(result.value.knownAt.kind).toBe("snapshot");
});
