import type { CaptureEvent } from "@kizuki/core";
import type { FrontmatterValue, ProposalInput } from "@kizuki/core/staging";
import { OUTPUT_LIMITS, sanitizeBlock, sanitizeLine } from "./output";
import type {
  ClaimsOutput,
  EntitiesOutput,
  EntityType,
  SummaryOutput,
} from "./output";
import { PROMPT_VERSION } from "./prompt";

export interface DraftContext {
  event: CaptureEvent;
  /** The configured model, not the one the endpoint claims to have served. */
  model: string;
}

/**
 * A model draft never outranks the deterministic floor, which files its
 * verbatim captures at 1. Review order therefore puts what the machine can
 * prove above what a model believes.
 */
export const CONFIDENCE_CAPS = {
  summary: 0.9,
  entity: 0.75,
  claims: 0.9,
} as const;

const SLUG_MAX = 64;

/**
 * Produces a segment `promote` will accept as a path component. When a name
 * has no usable ASCII at all, a hash of the original keeps two different
 * names on two different pages instead of colliding on one.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, SLUG_MAX)
    .replace(/[-._]+$/, "");
  if (slug.length > 0) return slug;
  const digest = new Bun.CryptoHasher("sha256").update(name).digest("hex");
  return `x${digest.slice(0, 12)}`;
}

export function entityTarget(type: EntityType, name: string): string {
  return `${type}:${slugify(name)}`;
}

/** Mirrors `pageRelPath` for a target-bearing proposal. */
export function targetRelPath(target: string): string {
  return `${target.split(/[:/]/).join("/")}.md`;
}

function common(ctx: DraftContext): Record<string, FrontmatterValue> {
  return {
    "x-producer": "llm",
    "x-model": ctx.model,
    "x-prompt-version": PROMPT_VERSION,
    "x-connector": ctx.event.connector_id,
    "x-capture-kind": ctx.event.kind,
  };
}

function subjectIds(event: CaptureEvent): string[] {
  return [...new Set(event.subjects.map((subject) => subject.subject_id))];
}

function provenanceMarker(event: CaptureEvent): string {
  return `ev:${event.event_id}`;
}

function origin(ctx: DraftContext): string {
  return `llm (${ctx.model}, prompt ${PROMPT_VERSION}) from \`${ctx.event.connector_id}\` (${ctx.event.kind}) at ${ctx.event.occurred_at}`;
}

export function summaryDraft(
  ctx: DraftContext,
  out: SummaryOutput,
): ProposalInput {
  const { event } = ctx;
  const header = `Draft summary by llm (${ctx.model}, prompt ${PROMPT_VERSION}) of \`${event.connector_id}\` (${event.kind}) at ${event.occurred_at}; unreviewed.`;
  return {
    kind: "claim",
    target: null,
    body: [
      header,
      "",
      sanitizeBlock(out.summary, OUTPUT_LIMITS.summary),
      "",
      `Sources: (${provenanceMarker(event)})`,
    ].join("\n"),
    frontmatter: {
      type: "fact",
      title: sanitizeLine(out.title, OUTPUT_LIMITS.title),
      ...common(ctx),
    },
    provenance: [event.event_id],
    subjects: subjectIds(event),
    producer: "llm",
    confidence: Math.min(out.confidence, CONFIDENCE_CAPS.summary),
  };
}

export function entityDrafts(
  ctx: DraftContext,
  out: EntitiesOutput,
): ProposalInput[] {
  const { event } = ctx;
  const drafts: ProposalInput[] = [];
  const seen = new Set<string>();
  for (const candidate of out.entities) {
    const target = entityTarget(candidate.type, candidate.name);
    if (seen.has(target)) continue;
    seen.add(target);
    const aliases = candidate.aliases;
    drafts.push({
      kind: "entity",
      target,
      body: [
        `Entity candidate \`${target}\` (${candidate.type}) drafted by ${origin(ctx)}; unreviewed.`,
        "",
        "Evidence (captured text as quoted by the model):",
        "",
        `> ${sanitizeLine(candidate.evidence, OUTPUT_LIMITS.evidence)}`,
        "",
        `Sources: (${provenanceMarker(event)})`,
      ].join("\n"),
      frontmatter: {
        type: candidate.type,
        title: sanitizeLine(candidate.name, OUTPUT_LIMITS.name),
        ...common(ctx),
        ...(aliases.length > 0 ? { "x-aliases": aliases } : {}),
      },
      provenance: [event.event_id],
      subjects: subjectIds(event),
      producer: "llm",
      confidence: Math.min(candidate.confidence, CONFIDENCE_CAPS.entity),
    });
  }
  return drafts;
}

export function claimsDraft(
  ctx: DraftContext,
  out: ClaimsOutput,
): ProposalInput {
  const { event } = ctx;
  const marker = provenanceMarker(event);
  const lines = out.claims.map((claim) => {
    const statement = sanitizeLine(claim.statement, OUTPUT_LIMITS.statement);
    return claim.subject_id === null
      ? `- ${statement} (${marker})`
      : `- ${statement} (subject: ${claim.subject_id}; ${marker})`;
  });
  const subjects = new Set(subjectIds(event));
  for (const claim of out.claims) {
    if (claim.subject_id !== null) subjects.add(claim.subject_id);
  }
  const lowest = out.claims.reduce<number>(
    (least, claim) => Math.min(least, claim.confidence),
    CONFIDENCE_CAPS.claims,
  );
  return {
    kind: "claim",
    target: null,
    body: [
      `Claims drafted by ${origin(ctx)}; unreviewed. One line per atomic claim; confirm, edit or reject.`,
      "",
      ...lines,
    ].join("\n"),
    frontmatter: {
      type: "fact",
      title: `Claims from ${event.connector_id} at ${event.occurred_at}`,
      ...common(ctx),
      "x-claim-count": out.claims.length,
    },
    provenance: [event.event_id],
    subjects: [...subjects],
    producer: "llm",
    confidence: lowest,
  };
}
