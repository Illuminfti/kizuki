import type { Claim } from "../contracts/proposal";
import { getClaim } from "../claims/store";
import { claimReadSql } from "../claims/read-scope";
import { tableExists } from "../ledger/schema";
import type { ServeContext } from "../serving/types";
import { authorizedClaimSql, authorizedSupportSql } from "./policy-sql";
import { readWorldCard } from "./pipeline/read";
import { newReadFrame } from "./pipeline/frame";
import { worldNamespace, resolveWorldClaim } from "./references";
import { worldDependencies, type WorldDependencies } from "./dependencies";
import { SITUATION_CARD_V2_SCHEMA, type SituationCardV2 } from "../contracts/situation-card-v2";
import type { Relation } from "../contracts/world-card-kit";
import type { ReadBudget } from "./projection";

type SituationPredicate = string;

export interface SituationItem {
  /** The stored claim, already cleared by the caller's reader. */
  readonly claim: Claim;
  readonly claimIds?: readonly string[];
  readonly predicate: SituationPredicate;
  readonly text: string;
  readonly mode: string;
  readonly polarity: "positive" | "negative";
}

export interface SituationState {
  readonly world: WorldDependencies;
  readonly label: string | null;
  readonly objective: readonly SituationItem[];
  readonly blocker: readonly SituationItem[];
  readonly change: readonly SituationItem[];
  readonly commitments: readonly SituationItem[];
  /** Hedged, negated or competing statements. Never merged into the asserted fields. */
  readonly uncertain: readonly SituationItem[];
  readonly subject: string;
}

interface SubjectRow {
  handle_id: string;
  raw_kind: string;
  raw_namespace: string;
  raw_id: string;
}

/**
 * Current Situations for one principal: a wire-free, write-free read of the
 * world model. Each claim must clear the same per-support policy as
 * `world_view` and the caller's `canRead`, so a denied or unproven claim is
 * absent rather than redacted. Newest situation first.
 */
export function readSituations(
  ctx: ServeContext,
  options: {
    limit: number;
    at: string;
    subjects?: readonly string[];
    canRead: (claim: Claim) => boolean;
  },
): SituationState[] {
  return ctx.db.transaction(() => readSituationsSnapshot(ctx, options))();
}

/** Session callers cannot supply an old instant and borrow present outcome evidence. */
export function readCurrentSituations(ctx: ServeContext, options: {
  limit: number; subjects?: readonly string[]; canRead: (claim: Claim) => boolean;
}): SituationState[] {
  const at = new Date().toISOString();
  return ctx.db.transaction(() => readSituationsSnapshot(ctx, { ...options, at, currentOutcomeAt: at }))();
}

function readSituationsSnapshot(ctx: ServeContext, options: { limit: number; at: string; currentOutcomeAt?: string; subjects?: readonly string[]; canRead: (claim: Claim) => boolean }): SituationState[] {
  if (
    !tableExists(ctx.db, "claim_v2_semantics") ||
    !tableExists(ctx.db, "semantic_bindings")
  )
    return [];
  const permitted = authorizedSupportSql(ctx);
  const typed = authorizedClaimSql(ctx);
  const readable = claimReadSql(ctx.db, {
    grant: ctx.principal.grant,
    source: {
      owner: ctx.principal.kind === "owner",
      purpose: ctx.sourcePurpose ?? "session",
    },
  }, "base");
  const subjects = ctx.db
    .query<SubjectRow, (string | number)[]>(
      `SELECT b.handle_id, b.raw_kind, b.raw_namespace, b.raw_id
         FROM semantic_bindings b
         JOIN claim_v2_semantics c ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id
          AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
         JOIN claims base ON base.claim_id=c.claim_id
        WHERE c.predicate='world.kind' AND base.status='live' AND c.polarity='positive'
          AND json_extract(c.payload,'$.object.ref.id')='world/situation'
          AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
          AND ${readable.sql}
          AND ${typed.sql}
        GROUP BY b.handle_id
        ORDER BY max(base.asserted_at) DESC, b.handle_id`,
    )
    .iterate(...permitted.bindings, ...readable.bindings, ...typed.bindings);

  const budget: ReadBudget = { bytes: 0 };
  const out: SituationState[] = [];
  for (const row of subjects) {
    if (out.length === options.limit) break;
    if (
      options.subjects !== undefined &&
      !options.subjects.includes(row.raw_id)
    )
      continue;
    const state = readOne(ctx, row, options, budget);
    if (state !== null) out.push(state);
  }
  return out;
}

function readOne(
  ctx: ServeContext,
  row: SubjectRow,
  options: { at: string; currentOutcomeAt?: string; canRead: (claim: Claim) => boolean },
  budget: ReadBudget,
): SituationState | null {
  const ns = worldNamespace(ctx.db,ctx.principal), world = worldDependencies();
  const frame = { ...newReadFrame(ctx,ns,{kind:"at",at:options.at},world), budget,
    ...(options.currentOutcomeAt === undefined ? {} : { currentOutcomeAt: options.currentOutcomeAt }) };
  const card = readWorldCard(frame,row.handle_id,"situation",SITUATION_CARD_V2_SCHEMA) as SituationCardV2 | null;
  if (card === null) return null;
  // Prime the caller's existing claim publication reader with every dependency,
  // including the classification, linked-node and status basis.
  const claims = new Map<string,Claim>();
  for (const id of world.claims) { const claim = getClaim(ctx.db,id); if (claim !== null && options.canRead(claim)) claims.set(id,claim); }
  const item = (relation: Relation, text?: string): SituationItem | null => {
    const id = resolveWorldClaim(ctx.db,ns,relation.claim.token), claim = id === null ? null : claims.get(id);
    if (!claim) return null;
    const value = relation.object;
    return { claim, predicate: relation.predicate, text: text ?? (value.kind === "literal" ? value.value : value.kind === "vocabulary" ? value.id : "linked item"),
      mode: relation.perspective.mode, polarity: relation.polarity, claimIds: [...claims.keys()] };
  };
  const items = (relations: readonly Relation[]) => relations.flatMap(r => {const found=item(r);return found === null ? [] : [found];});
  const commitments = items(card.statedCommitments.filter(r => r.polarity === "positive" && r.perspective.mode === "asserted"));
  for (const commitment of card.commitments) {
    if (commitment.status === "done" || commitment.status === "dropped") continue;
    const basis = commitment.label ?? commitment.due[0];
    if (basis === undefined || basis === null) continue;
    const label = commitment.label?.object.kind === "literal" ? commitment.label.object.value : "unnamed commitment";
    const due = commitment.due.map(r => `${r.object.kind === "literal" ? r.object.value : "unknown"} (${r.perspective.mode}${r.perspective.holder === null ? "" : `; holder ${r.perspective.holder.token}`})`).join("; ") || "unknown";
    const found = item(basis,`${label}; status=${commitment.status}; overdue=${commitment.overdue}; due=${due}`);
    if (found !== null) commitments.push({...found,predicate:"situation.commitment"});
  }
  return { world, subject:row.raw_id, label:card.situation.labels[0]?.text ?? null,
    objective:items(card.objective === null ? [] : [card.objective]), blocker:items(card.blocker === null ? [] : [card.blocker]),
    change:items(card.recentChange === null ? [] : [card.recentChange]), commitments,
    uncertain:items(card.uncertainty),
  };
}
