import { expect, test } from "bun:test";
import {
  SITUATION_CARD_SCHEMA,
  validateSituationCard,
} from "../../src/contracts/situation-card";

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
const PARTICIPANT = token(6);

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

function relation(predicate = "situation.objective") {
  return {
    schema: "kizuki.relation/v1",
    claim: ref("claim", CLAIM),
    subject: ref("object", OBJECT),
    predicate,
    object: { kind: "literal", value: "finish the world card" },
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
    schema: SITUATION_CARD_SCHEMA,
    situation: {
      schema: "kizuki.knowledge-node/v1",
      ref: ref("object", OBJECT),
      kind: "situation",
      classificationClaims: [ref("claim", CLAIM)],
      labels: [{ text: "world-card", claim: ref("claim", CLAIM) }],
      resolution: "distinct",
    },
    summary: {
      text: "Finish the first Situation card on main.",
      admissions: [ref("admission", ADMISSION)],
    },
    objective: relation(),
    participants: [ref("object", PARTICIPANT)],
    commitments: [relation("situation.commitment")],
    blocker: null,
    recentChange: relation("situation.recent_change"),
    uncertainty: [relation("situation.uncertainty")],
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

test("locks the accepted situation-card schema", () => {
  expect(SITUATION_CARD_SCHEMA).toBe("kizuki.situation-card/v1");
});

test("a closed situation card round-trips through the validator", () => {
  const result = validateSituationCard(card());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.schema).toBe(SITUATION_CARD_SCHEMA);
  expect(result.value.situation.kind).toBe("situation");
  expect(result.value.commitments).toHaveLength(1);
  expect(result.value.blocker).toBeNull();
});

test("unknown extra keys are refused", () => {
  expect(validateSituationCard(card({ writer: "no" })).ok).toBe(false);
});

test("a concept node is refused on a situation card", () => {
  expect(
    validateSituationCard(
      card({
        situation: {
          schema: "kizuki.knowledge-node/v1",
          ref: ref("object", OBJECT),
          kind: "concept",
          classificationClaims: [ref("claim", CLAIM)],
          labels: [{ text: "grace", claim: ref("claim", CLAIM) }],
          resolution: "distinct",
        },
      }),
    ).ok,
  ).toBe(false);
});

test("a malformed wire token is refused", () => {
  expect(
    validateSituationCard(
      card({
        knownAt: { kind: "snapshot", ref: ref("snapshot", "not-a-token") },
      }),
    ).ok,
  ).toBe(false);
});

test("overlap validity must end after it starts", () => {
  expect(
    validateSituationCard(
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

test("a snapshot knownAt is accepted", () => {
  const result = validateSituationCard(
    card({
      summary: null,
      objective: null,
      commitments: [],
      recentChange: null,
      uncertainty: [],
      knownAt: { kind: "snapshot", ref: ref("snapshot", SNAPSHOT) },
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.summary).toBeNull();
  expect(result.value.objective).toBeNull();
  expect(result.value.knownAt.kind).toBe("snapshot");
});
