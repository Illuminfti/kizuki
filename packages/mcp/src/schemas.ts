import { ENVELOPE_SCHEMA, TOOLS } from "@kizuki/core";
import { z } from "zod";

/**
 * The advertised bounds mirror the engine's own validators. They are a
 * convenience for the client, never the enforcement point: core re-checks
 * everything that reaches it.
 */
const SENSITIVITY = z.enum(["public", "personal", "private"]);
const ID = z.string().min(1).max(64);
const RFC3339 = z.string().min(20).max(40);

const CANON_CHUNK = z.object({
  page_id: z.string(),
  path: z.string(),
  title: z.string(),
  type: z.string(),
  sensitivity: SENSITIVITY,
  subjects: z.array(z.string()),
  sources: z.array(z.string()),
  excerpt: z.string(),
  truncated: z.boolean(),
});

const QUOTED_CHUNK = z.object({
  event_id: z.string(),
  connector_id: z.string(),
  kind: z.string(),
  occurred_at: z.string(),
  sensitivity: SENSITIVITY,
  subjects: z.array(z.string()),
  text: z.string(),
  tainted: z.literal(true),
});

const DENIED = z.object({ reason: z.string(), count: z.int() });

export const ENVELOPE_SHAPE = z.object({
  schema: z.literal(ENVELOPE_SCHEMA),
  tool: z.enum(TOOLS),
  principal: z.string(),
  at: z.string(),
  canon: z.array(CANON_CHUNK),
  quoted: z.array(QUOTED_CHUNK),
  denied: z.array(DENIED),
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
  budget_tokens: z.int().min(100).max(2000).optional(),
  include: z
    .array(z.enum(["canon", "graph", "timeline"]))
    .max(3)
    .optional(),
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
