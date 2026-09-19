import { expect, test } from "bun:test";
import {
  OBSERVATION_RECORD_SCHEMA,
  validateDurableObservation,
} from "../../src/contracts/durable-observation";

const EVENT_ID = "01JCV2EVENTAAAAAAAAAAAAAA1";
const OBSERVATION_ID = "01JCV2EVENTAAAAAAAAAAAAAA2";
const ADMISSION_ID = "01JCV2EVENTAAAAAAAAAAAAAA3";
const EVIDENCE_ID = "01JCV2EVENTAAAAAAAAAAAAAA4";
const ATTRIBUTION_ID = "01JCV2EVENTAAAAAAAAAAAAAA5";
const HASH = "a".repeat(64);
const ACCEPTED_AT = "2026-01-02T00:00:00.000Z";

function observation(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: OBSERVATION_RECORD_SCHEMA,
    id: OBSERVATION_ID,
    admissionId: ADMISSION_ID,
    evidence: [
      {
        id: EVIDENCE_ID,
        admissionId: ADMISSION_ID,
        eventId: EVENT_ID,
        eventHashVersion: 1,
        eventHash: HASH,
        textHash: HASH,
        originBinding: "source:mail",
        eventAcceptedAt: ACCEPTED_AT,
        sourceBinding: {
          sourceKey: "mail",
          grantRevision: 1,
          policyDigest: HASH,
        },
        span: { kind: "text", startUtf16: 0, endUtf16: 12 },
      },
    ],
    attribution: [
      {
        id: ATTRIBUTION_ID,
        role: "sender",
        ref: { kind: "occurrence", id: "occ-grace" },
        basis: "source_field",
        field: "from",
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    fidelity: "verbatim_text",
    occurred: {
      kind: "known",
      from: "2026-01-01T00:00:00.000Z",
      until: null,
    },
    sourceObservedAt: ACCEPTED_AT,
    recorded: { admittedAt: ACCEPTED_AT, admissionSeq: 1 },
    ...overrides,
  };
}

test("locks the accepted observation-record schema", () => {
  expect(OBSERVATION_RECORD_SCHEMA).toBe("kizuki.observation-record/v1");
});

test("a closed observation round-trips through the validator", () => {
  const result = validateDurableObservation(observation());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.schema).toBe(OBSERVATION_RECORD_SCHEMA);
  expect(result.value.evidence).toHaveLength(1);
  expect(result.value.attribution[0]?.role).toBe("sender");
});

test("unknown extra keys are refused", () => {
  expect(validateDurableObservation(observation({ summary: "no" })).ok).toBe(
    false,
  );
});

test("unknown occurrence cannot carry a time window", () => {
  expect(
    validateDurableObservation(
      observation({
        occurred: {
          kind: "unknown",
          from: "2026-01-01T00:00:00.000Z",
          until: null,
        },
      }),
    ).ok,
  ).toBe(false);
});

test("a text span must end after it starts", () => {
  expect(
    validateDurableObservation(
      observation({
        evidence: [
          {
            id: EVIDENCE_ID,
            admissionId: ADMISSION_ID,
            eventId: EVENT_ID,
            eventHashVersion: 1,
            eventHash: HASH,
            textHash: HASH,
            originBinding: "source:mail",
            eventAcceptedAt: ACCEPTED_AT,
            sourceBinding: null,
            span: { kind: "text", startUtf16: 4, endUtf16: 4 },
          },
        ],
        attribution: [],
      }),
    ).ok,
  ).toBe(false);
});

test("attribution cannot cite evidence the observation does not hold", () => {
  expect(
    validateDurableObservation(
      observation({
        attribution: [
          {
            id: ATTRIBUTION_ID,
            role: "sender",
            ref: { kind: "occurrence", id: "occ-grace" },
            basis: "source_field",
            field: "from",
            evidenceIds: ["01JCV2EVENTAAAAAAAAAAAAAA6"],
          },
        ],
      }),
    ).ok,
  ).toBe(false);
});

test("a malformed event hash is refused", () => {
  expect(
    validateDurableObservation(
      observation({
        evidence: [
          {
            id: EVIDENCE_ID,
            admissionId: ADMISSION_ID,
            eventId: EVENT_ID,
            eventHashVersion: 1,
            eventHash: "not-a-hash",
            textHash: HASH,
            originBinding: "source:mail",
            eventAcceptedAt: ACCEPTED_AT,
            sourceBinding: null,
            span: { kind: "text", startUtf16: 0, endUtf16: 12 },
          },
        ],
        attribution: [],
      }),
    ).ok,
  ).toBe(false);
});
