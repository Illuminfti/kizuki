import { z } from "zod";

const TIME = z.string().min(20).max(40);
export const WIRE_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const WORLD_OBJECT_REF = z.strictObject({
  kind: z.literal("object"),
  token: WIRE_TOKEN,
});
const WORLD_SNAPSHOT_REF = z.strictObject({
  kind: z.literal("snapshot"),
  token: WIRE_TOKEN,
});
export const WORLD_VALID = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("unknown_only") }),
  z.strictObject({ kind: z.literal("at"), at: TIME }),
  z.strictObject({ kind: z.literal("overlap"), from: TIME, until: TIME }),
]);
export const WORLD_KNOWN_AT = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("time"), at: TIME }),
  z.strictObject({ kind: z.literal("snapshot"), ref: WORLD_SNAPSHOT_REF }),
]);

/** Shared by every operation that lists by label, so the flat input carries one `label` and one `cursor`. */
export const LABEL = z.string().max(200).default("");
export const CURSOR = WIRE_TOKEN.optional();

export const worldRef = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), token: WIRE_TOKEN });
const worldEvidence = z.strictObject({
  admission: worldRef("admission"),
  eventVersion: worldRef("event_version"),
  span: z.union([
    z.strictObject({ kind: z.literal("text"), startUtf16: z.number().int().nonnegative(), endUtf16: z.number().int().positive() }),
    z.strictObject({ kind: z.literal("metadata"), field: z.string().max(128) }),
  ]),
});
export const worldRelation = z.strictObject({
  schema: z.literal("kizuki.relation/v1"),
  claim: worldRef("claim"),
  subject: WORLD_OBJECT_REF,
  predicate: z.string().max(128),
  object: z.union([
    z.strictObject({ kind: z.literal("literal"), value: z.string().max(400) }),
    z.strictObject({ kind: z.literal("vocabulary"), id: z.string().max(128) }),
    z.strictObject({ kind: z.literal("node"), ref: WORLD_OBJECT_REF }),
  ]),
  perspective: z.strictObject({
    holder: WORLD_OBJECT_REF.nullable(),
    speaker: WORLD_OBJECT_REF.nullable(),
    addressee: WORLD_OBJECT_REF.nullable(),
    mode: z.enum(["asserted", "quoted", "reported", "hypothetical", "suggested", "questioned", "uncertain"]),
    interpretation: z.enum(["explicit", "inferred"]),
    evidence: z.array(worldEvidence).max(256),
  }),
  context: z.array(WORLD_OBJECT_REF).max(256),
  polarity: z.enum(["positive", "negative"]),
  valid: z.union([
    z.strictObject({ kind: z.literal("unknown") }),
    z.strictObject({ kind: z.literal("known"), from: z.string(), until: z.string().nullable() }),
  ]),
  temporalBasis: z.enum(["explicit", "observed", "unknown"]),
  assessments: z
    .array(
      z.strictObject({
        admission: worldRef("admission"),
        epistemicKind: z.enum(["observed", "reported", "owner_assertion", "model_inference", "hypothesis", "recommendation", "scenario"]),
        authority: z.enum(["owner_correction", "owner_authored", "connector_evidence", "model_inference"]),
        confidence: z.union([
          z.strictObject({ kind: z.literal("unknown") }),
          z.strictObject({ kind: z.literal("known"), value: z.number().min(0).max(1) }),
        ]),
        independence: z.enum(["independent", "dependent", "unknown"]),
        evidence: z.array(worldEvidence).max(256),
      }),
    )
    .max(256),
  conflict: z.enum(["none_observed", "present", "unknown"]),
});
export const worldGaps = z.enum(["coverage", "pending_consolidation", "stale_dependencies", "required_context_overflow", "traversal_limit"]);
export const worldCoverage = z.strictObject({
  status: z.enum(["complete_for_query", "partial"]),
  gaps: z.array(worldGaps).max(5),
  validWindow: WORLD_VALID,
  history: z.enum(["retained_for_query", "baseline_only", "unavailable"]),
});
export const worldNode = <K extends string>(kind: K) =>
  z.strictObject({
    schema: z.literal("kizuki.knowledge-node/v1"),
    ref: WORLD_OBJECT_REF,
    kind: z.literal(kind),
    classificationClaims: z.array(worldRef("claim")).max(256),
    labels: z.array(z.strictObject({ text: z.string().max(400), claim: worldRef("claim") })).max(256),
    resolution: z.enum(["distinct", "resolved", "ambiguous"]),
  });
/** What every card carries beside its own fields. */
export const worldCommon = {
  summary: z.strictObject({ text: z.string().max(1200), admissions: z.array(worldRef("admission")).max(256) }).nullable(),
  knownAt: z.strictObject({ kind: z.literal("current") }),
  coverage: worldCoverage,
};
