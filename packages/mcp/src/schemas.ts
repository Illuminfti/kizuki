import { AUTHORITY_TIERS, ENVELOPE_SCHEMA, PAGE_TAINTS, TOOLS } from "@kizuki/core";
import type { Tool } from "@kizuki/core";
import { z } from "zod";
import { MCP_WORLD_OPS } from "./world/ops";
import { buildWorldSurface } from "./world/surface";

/**
 * The advertised bounds mirror the engine's own validators. They are a
 * convenience for the client, never the enforcement point: core re-checks
 * everything that reaches it.
 */
const SENSITIVITY = z.enum(["public", "personal", "private"]);
const ID = z.string().min(1).max(64);
const RFC3339 = z.string().min(20).max(40);
const AUTHORITY = z.enum(Object.keys(AUTHORITY_TIERS) as [string, ...string[]]);
// Named, so `tools/list` states it once per tool rather than once per chunk kind.
const SUBJECT_LABEL = z.strictObject({
  subject: z.string(),
  display_name: z.string().nullable(),
  handles: z.array(z.string()).max(4),
  evidence: z.array(z.strictObject({
    claim_id: z.string(),
    authority: AUTHORITY,
    sources: z.array(z.string()).min(1).max(64),
  })).min(1).max(32),
}).meta({ id: "SubjectLabel" });

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

/** The tools whose `canon` and `quoted` lists can hold chunks. Every other tool always answers []. */
const CARRIES_CANON: readonly Tool[] = ["search", "get_page", "query_entities", "context_packet"];
const CARRIES_QUOTED: readonly Tool[] = ["search", "timeline", "context_packet"];
const NO_CHUNKS = z.array(z.never()).max(0);

/**
 * What one tool advertises. Stating the tool and the lists it can fill, rather
 * than the union over all ten, is most of what keeps `tools/list` small.
 */
export function envelopeFor(tool: Tool) {
  return ENVELOPE_SHAPE.extend({
    tool: z.literal(tool),
    ...(CARRIES_CANON.includes(tool) ? {} : { canon: NO_CHUNKS }),
    ...(CARRIES_QUOTED.includes(tool) ? {} : { quoted: NO_CHUNKS }),
  });
}

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
  event_id: ID.optional(),
  offset: z.int().min(0).max(100_000).optional(),
  span: z.int().min(1).max(2_000).optional(),
  integrity: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  task_event_id: ID.optional(),
  task_integrity: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
      world_claim: z.strictObject({ kind: z.literal("claim"), token: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/) }).optional(),
    }).refine((target) => [target.claim_id, target.claim_key, target.subject, target.world_claim].filter((value) => value !== undefined).length <= 1, "target names exactly one selector")
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

/** Generated from the registered operations' fragments; see `world/surface.ts`. */
export const WORLD = buildWorldSurface(MCP_WORLD_OPS);
export const WORLD_VIEW_INPUT = WORLD.input;
export const WORLD_ENVELOPE_SHAPE = WORLD.envelope;

/**
 * The whole envelope grammar. Written out, its cards run to about 140 KB of
 * JSON Schema, which every client would download on every `tools/list`; so the
 * server holds each world_view answer to this before it leaves, and
 * advertises the smaller shape below.
 */
export const WORLD_ENVELOPE = WORLD.answer;

/** The card grammar is named by `schema` and left to `kizuki.concept-card/v1` and its siblings. */
export const WORLD_ENVELOPE_LISTED = WORLD.listed;
