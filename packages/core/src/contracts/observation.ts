import { isPlainObject } from "../util/validate";
import { isRfc3339 } from "../util/time";
import { cardCodec, exact, evidenceRef, knownTime, type EvidenceRef, type KnownTime } from "./world-card-kit";
import { parseScopedRef, type CapturedSubjectRef, type ObservationRef } from "./scoped-refs";
export const OBSERVATION_SCHEMA = "kizuki.observation/v1" as const;
export type Observation = {
  readonly schema: typeof OBSERVATION_SCHEMA;
  readonly ref: ObservationRef;
  readonly evidence: readonly EvidenceRef[];
  readonly attribution: readonly {
    readonly role: "sender" | "recipient" | "quoted_author" | "thread" | "place";
    readonly ref: CapturedSubjectRef;
    readonly basis: "source_field";
    readonly field: string;
    readonly evidence: readonly EvidenceRef[];
  }[];
  readonly fidelity: "verbatim_text" | "source_metadata" | "lossy_transcript";
  readonly occurred: KnownTime;
  readonly sourceObservedAt: string | null;
  readonly admittedAt: string;
};
const evidence = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(evidenceRef);
export const validateObservation = cardCodec<Observation, "observation">({ schema: OBSERVATION_SCHEMA, label: "observation", fields: {
  ref: value => parseScopedRef(value)?.kind === "observation",
  evidence,
  attribution: value => Array.isArray(value) && value.length <= 256 && value.every(item => isPlainObject(item) &&
    exact(item, ["role", "ref", "basis", "field", "evidence"]) && ["sender", "recipient", "quoted_author", "thread", "place"].includes(String(item.role)) &&
    parseScopedRef(item.ref)?.kind === "captured_subject" && item.basis === "source_field" && typeof item.field === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(item.field) && evidence(item.evidence)),
  fidelity: value => ["verbatim_text", "source_metadata", "lossy_transcript"].includes(String(value)),
  occurred: knownTime, sourceObservedAt: value => value === null || isRfc3339(value), admittedAt: isRfc3339,
} });
