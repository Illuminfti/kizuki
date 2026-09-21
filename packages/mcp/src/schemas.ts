import { AUTHORITY_TIERS, ENVELOPE_SCHEMA, PAGE_TAINTS, TOOLS } from "@kizuki/core";
import { z } from "zod";

/**
 * The advertised bounds mirror the engine's own validators. They are a
 * convenience for the client, never the enforcement point: core re-checks
 * everything that reaches it.
 */
const SENSITIVITY = z.enum(["public", "personal", "private"]);
const ID = z.string().min(1).max(64);
const RFC3339 = z.string().min(20).max(40);
const AUTHORITY = z.enum(Object.keys(AUTHORITY_TIERS) as [string, ...string[]]);
const SUBJECT_LABEL = z.strictObject({
  subject: z.string(),
  display_name: z.string().nullable(),
  handles: z.array(z.string()).max(4),
  evidence: z.array(z.strictObject({
    claim_id: z.string(),
    authority: AUTHORITY,
    sources: z.array(z.string()).min(1).max(64),
  })).min(1).max(32),
});

/**
 * Every field the engine puts on a chunk is described here. The objects are
 * closed, so a field the engine sends and this shape omits makes a client
 * that listed the tools first reject the whole answer.
 */
const CANON_CHUNK = z.strictObject({
  page_id: z.string(),
  path: z.string(),
  title: z.string(),
  type: z.string(),
  sensitivity: SENSITIVITY,
  taint: z.enum(PAGE_TAINTS),
  authority: AUTHORITY.nullable(),
  subjects: z.array(z.string()),
  sources: z.array(z.string()),
  excerpt: z.string(),
  truncated: z.boolean(),
  subject_labels: z.array(SUBJECT_LABEL).max(50).optional(),
});

const QUOTED_CHUNK = z.strictObject({
  event_id: z.string(),
  connector_id: z.string(),
  kind: z.string(),
  occurred_at: z.string(),
  sensitivity: SENSITIVITY,
  subjects: z.array(z.string()),
  text: z.string(),
  tainted: z.literal(true),
  subject_labels: z.array(SUBJECT_LABEL).max(50).optional(),
});

const DENIED = z.strictObject({ reason: z.string(), count: z.int() });

/** Exact object core emits once the source-policy epoch is positive; omitted at epoch 0. */
const SOURCE_POLICY = z.strictObject({
  mode: z.literal("enforced"),
  epoch: z.int().min(1),
  legacy_unbound: z.literal("owner_only"),
});

export const ENVELOPE_SHAPE = z.strictObject({
  schema: z.literal(ENVELOPE_SCHEMA),
  tool: z.enum(TOOLS),
  principal: z.string(),
  at: z.string(),
  canon: z.array(CANON_CHUNK),
  quoted: z.array(QUOTED_CHUNK),
  denied: z.array(DENIED),
  /** Owner envelopes only; omitted when nothing was withheld. */
  has_withheld: z.literal(true).optional(),
  source_policy: SOURCE_POLICY.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const SEARCH_INPUT = z.strictObject({
  query: z.string().min(1).max(512),
  scope: z.enum(["canon", "ledger", "all"]).optional(),
  limit: z.int().min(1).max(50).optional(),
  types: z.array(ID).max(16).optional(),
  subjects: z.array(ID).max(16).optional(),
  since: RFC3339.optional(),
  until: RFC3339.optional(),
});

export const GET_PAGE_INPUT = z.strictObject({
  id: z.string().min(1).max(256).optional(),
  path: z.string().min(4).max(256).optional(),
});

export const ENTITIES_INPUT = z.strictObject({
  type: z.enum(["person", "org", "project", "place", "topic"]).optional(),
  name: z.string().min(1).max(128).optional(),
  limit: z.int().min(1).max(50).optional(),
});

export const TIMELINE_INPUT = z.strictObject({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  since: RFC3339.optional(),
  until: RFC3339.optional(),
  subject: ID.optional(),
  connector_id: ID.optional(),
  kind: ID.optional(),
  limit: z.int().min(1).max(200).optional(),
});

export const GRAPH_INPUT = z.strictObject({
  id: ID,
  depth: z.int().min(1).max(2).optional(),
  kinds: z
    .array(z.enum(["wikilink", "subject", "source"]))
    .max(3)
    .optional(),
});

export const HEALTH_INPUT = z.strictObject({});

export const PACKET_INPUT = z.strictObject({
  query: z.string().min(1).max(512).optional(),
  subjects: z.array(ID).max(16).optional(),
  since: RFC3339.optional(),
  until: RFC3339.optional(),
  budget_tokens: z.int().min(50).max(2000).optional(),
  include: z
    .array(z.enum(["canon", "graph", "timeline", "claims"]))
    .max(4)
    .optional(),
  purpose: z.enum(["session", "recall", "correction", "audit"]).optional(),
  capabilities: z.array(z.enum(["delta"])).max(1).optional(),
  hooks: z
    .array(z.enum(["session_start", "turn", "pre_compaction", "post_compaction", "session_end"]))
    .max(5)
    .optional(),
  retain_prefix: z.boolean().optional(),
  prior_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  epoch: z.int().min(0).optional(),
});

const MAX_FRONTMATTER_STRING = 4096;
const MAX_FRONTMATTER_ITEMS = 32;
const MAX_FRONTMATTER_KEYS = 32;
/** Mirrors the engine's ceiling on the whole bag, not only on each value. */
const MAX_FRONTMATTER_CHARS = 16384;

const FRONTMATTER_VALUE = z.union([
  z.string().max(MAX_FRONTMATTER_STRING),
  z.number(),
  z.boolean(),
  z.array(z.string().max(MAX_FRONTMATTER_STRING)).max(MAX_FRONTMATTER_ITEMS),
]);

function frontmatterChars(bag: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(bag)) {
    total += key.length;
    if (typeof value === "string") total += value.length;
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") total += entry.length;
      }
    }
  }
  return total;
}

export const CORRECT_INPUT = z.strictObject({
  statement: z.string().min(1).max(2000),
  target: z
    .strictObject({
      claim_id: ID.optional(),
      claim_key: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      subject: ID.optional(),
    })
    .optional(),
  object: z.string().min(1).max(1024).optional(),
  dry_run: z.boolean().optional(),
});

export const PROPOSE_INPUT = z.strictObject({
  kind: z.enum(["entity", "claim", "edit", "merge", "deletion"]),
  target: z.string().max(256).nullable().optional(),
  body: z.string().min(1).max(65536),
  frontmatter: z
    .record(z.string().max(64), FRONTMATTER_VALUE)
    .refine(
      (bag) => Object.keys(bag).length <= MAX_FRONTMATTER_KEYS,
      `must hold at most ${MAX_FRONTMATTER_KEYS} keys`,
    )
    .refine(
      (bag) => frontmatterChars(bag) <= MAX_FRONTMATTER_CHARS,
      `must hold at most ${MAX_FRONTMATTER_CHARS} characters in total`,
    )
    .optional(),
  subjects: z.array(ID).max(16).optional(),
  subject: ID.optional(),
  predicate: ID.optional(),
  object: z.string().min(1).max(1024).optional(),
  polarity: z.enum(["positive", "negative"]).optional(),
  provenance: z.array(ID).min(1).max(64),
  confidence: z.number().min(0).max(1).optional(),
});

const WIRE_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const WORLD_OBJECT_REF = z.strictObject({
  kind: z.literal("object"),
  token: WIRE_TOKEN,
});
const WORLD_SNAPSHOT_REF = z.strictObject({
  kind: z.literal("snapshot"),
  token: WIRE_TOKEN,
});
const WORLD_VALID = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("unknown_only") }),
  z.strictObject({ kind: z.literal("at"), at: RFC3339 }),
  z.strictObject({ kind: z.literal("overlap"), from: RFC3339, until: RFC3339 }),
]);
const WORLD_KNOWN_AT = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("time"), at: RFC3339 }),
  z.strictObject({ kind: z.literal("snapshot"), ref: WORLD_SNAPSHOT_REF }),
]);

export const WORLD_VIEW_INPUT = z.union([
  z.strictObject({operation:z.enum(["find_concepts","find_situations"]),label:z.string().max(200),valid:WORLD_VALID,knownAt:WORLD_KNOWN_AT}),
  z.strictObject({
    operation: z.literal("situation"),
    situation: WORLD_OBJECT_REF,
    valid: WORLD_VALID,
    knownAt: WORLD_KNOWN_AT,
  }),
  z.strictObject({
    operation: z.literal("concept"),
    concept: WORLD_OBJECT_REF,
    valid: WORLD_VALID,
    knownAt: WORLD_KNOWN_AT,
  }),
]);

const worldRef = <K extends string>(kind:K) => z.strictObject({kind:z.literal(kind),token:z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)});
const worldEvidence=z.strictObject({admission:worldRef("admission"),eventVersion:worldRef("event_version"),span:z.union([
  z.strictObject({kind:z.literal("text"),startUtf16:z.number().int().nonnegative(),endUtf16:z.number().int().positive()}),
  z.strictObject({kind:z.literal("metadata"),field:z.string().max(128)}),
])});
const worldRelation=z.strictObject({schema:z.literal("kizuki.relation/v1"),claim:worldRef("claim"),subject:WORLD_OBJECT_REF,predicate:z.string().max(128),
  object:z.union([z.strictObject({kind:z.literal("literal"),value:z.string().max(400)}),z.strictObject({kind:z.literal("vocabulary"),id:z.string().max(128)}),z.strictObject({kind:z.literal("node"),ref:WORLD_OBJECT_REF})]),
  perspective:z.strictObject({holder:WORLD_OBJECT_REF.nullable(),speaker:WORLD_OBJECT_REF.nullable(),addressee:WORLD_OBJECT_REF.nullable(),
    mode:z.enum(["asserted","quoted","reported","hypothetical","suggested","questioned","uncertain"]),interpretation:z.enum(["explicit","inferred"]),evidence:z.array(worldEvidence).max(256)}),
  context:z.array(WORLD_OBJECT_REF).max(256),polarity:z.enum(["positive","negative"]),
  valid:z.union([z.strictObject({kind:z.literal("unknown")}),z.strictObject({kind:z.literal("known"),from:z.string(),until:z.string().nullable()})]),
  temporalBasis:z.enum(["explicit","observed","unknown"]),assessments:z.array(z.strictObject({admission:worldRef("admission"),
    epistemicKind:z.enum(["observed","reported","owner_assertion","model_inference","hypothesis","recommendation","scenario"]),
    authority:z.enum(["owner_correction","owner_authored","connector_evidence","model_inference"]),
    confidence:z.union([z.strictObject({kind:z.literal("unknown")}),z.strictObject({kind:z.literal("known"),value:z.number().min(0).max(1)})]),
    independence:z.enum(["independent","dependent","unknown"]),evidence:z.array(worldEvidence).max(256)})).max(256),
  conflict:z.enum(["none_observed","present","unknown"])});
const worldGaps=z.enum(["coverage","pending_consolidation","stale_dependencies","required_context_overflow","traversal_limit"]);
const worldCoverage=z.strictObject({status:z.enum(["complete_for_query","partial"]),gaps:z.array(worldGaps).max(5),validWindow:WORLD_VALID,history:z.enum(["retained_for_query","baseline_only","unavailable"])});
const worldNode=<K extends string>(kind:K)=>z.strictObject({schema:z.literal("kizuki.knowledge-node/v1"),ref:WORLD_OBJECT_REF,kind:z.literal(kind),classificationClaims:z.array(worldRef("claim")).max(256),
  labels:z.array(z.strictObject({text:z.string().max(400),claim:worldRef("claim")})).max(256),resolution:z.enum(["distinct","resolved","ambiguous"])});
const worldCommon={summary:z.strictObject({text:z.string().max(1200),admissions:z.array(worldRef("admission")).max(256)}).nullable(),knownAt:z.strictObject({kind:z.literal("current")}),coverage:worldCoverage};
const worldData=z.union([
  z.strictObject({schema:z.literal("kizuki.concept-card/v1"),concept:worldNode("concept"),...worldCommon,definitions:z.array(worldRelation).max(256),relations:z.array(worldRelation).max(256),
    learning:z.array(z.strictObject({facet:z.enum(["exposure","explanation","application","demonstration"]),assertion:worldRelation,assistance:z.enum(["assisted","unassisted","unknown"]),assistanceEvidence:z.array(worldRelation).max(256)})).max(256)}),
  z.strictObject({schema:z.literal("kizuki.situation-card/v1"),situation:worldNode("situation"),...worldCommon,objective:worldRelation.nullable(),participants:z.array(WORLD_OBJECT_REF).max(256),commitments:z.array(worldRelation).max(256),blocker:worldRelation.nullable(),recentChange:worldRelation.nullable(),uncertainty:z.array(worldRelation).max(256)}),
  z.strictObject({schema:z.enum(["kizuki.concept-matches/v1","kizuki.situation-matches/v1"]),matches:z.array(z.strictObject({ref:WORLD_OBJECT_REF,labels:z.array(z.string().max(400)).max(256)})).max(32),coverage:worldCoverage}),
]);
export const WORLD_ENVELOPE_SHAPE={schema:z.literal("kizuki.envelope/v2"),tool:z.literal("world_view"),principal:worldRef("principal"),at:z.string(),canon:z.array(z.never()).max(0),quoted:z.array(z.never()).max(0),
  data:z.union([z.strictObject({status:z.literal("not_found")}),z.strictObject({schema:z.literal("kizuki.world-view/v1"),operation:z.enum(["concept","situation","find_concepts","find_situations"]),result:z.union([
    z.strictObject({status:z.literal("current"),view:z.strictObject({status:z.literal("not_issued")}),data:worldData}),
    z.strictObject({status:z.literal("incomplete"),data:worldData,reasons:z.array(worldGaps).max(5)}),
    z.strictObject({status:z.literal("unavailable"),reason:z.enum(["storage","history","budget"])}),
  ])})])};
