import { createHash } from "node:crypto";
import { ATTENTION_SCHEMA, validateAttention, type Attention, type AttentionCandidate, type AttentionSource } from "../../contracts/attention";
import type { SituationCard } from "../../contracts/situation-card";
import { SITUATION_CARD_V2_SCHEMA, type SituationCardV2 } from "../../contracts/situation-card-v2";
import type { Relation, ViewGap } from "../../contracts/world-card-kit";
import { canonicalJson } from "../../util/hash";
import { issuedOpaqueFields } from "../../util/issued-opaque";
import { loadConfiguredModelRef } from "../../serve/config";
import { readSourceCoverage } from "../coverage";
import { collectConsolidationBasis } from "../consolidation/basis";
import { newReadFrame } from "../pipeline/frame";
import { readWorldCard, readWorldMatches } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import { worldDependencies, type WorldDependencies } from "../dependencies";
import type { WorldFrame, WorldValidQuery } from "../ops/types";
import { situationCues, type SituationCue } from "./providers/situation";
import { commitmentCues } from "./providers/commitment";
import { attentionCoverageStates } from "./providers/coverage";

export const ATTENTION_CANDIDATE_LIMIT = 16;
const SCAN_LIMIT = 32;
export interface AttentionEntry {
  readonly candidate: AttentionCandidate;
  readonly handle: string;
  readonly dependencies: WorldDependencies;
  readonly sources: readonly string[];
  readonly deliveredAt: string | null;
}
export interface AttentionRead { readonly data: Attention; readonly entries: readonly AttentionEntry[] }
const order: Record<AttentionSource, number> = { blocker: 0, commitment_due: 1, uncertainty: 2, stale_summary: 3 };

/** Only semantic fields already returned to this principal determine novelty. */
function visibleMeaning(row: Relation) {
  return { subject: row.subject, predicate: row.predicate, object: row.object, perspective: row.perspective,
    polarity: row.polarity, valid: row.valid };
}
function key(frame: WorldFrame, cue: SituationCue, subject: string): string {
  const basis = cue.grounds.map(visibleMeaning).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return createHash("sha256").update(canonicalJson({ namespace: frame.ns.id, provider: cue.source, subject, basis, ...(cue.detail === undefined ? {} : { detail: cue.detail }) })).digest("base64url");
}
function mergeDependencies(target: WorldDependencies | undefined, source: WorldDependencies): void {
  if (target === undefined) return;
  for (const id of source.claims) target.claims.add(id);
  for (const id of source.supports) target.supports.add(id);
  for (const id of source.events) target.events.add(id);
  for (const [id, receipt] of source.identityReceipts) target.identityReceipts.set(id, receipt);
  for (const [id, summary] of source.consolidations) target.consolidations.set(id, summary);
  target.coverage = source.coverage;
}
/** Must run in the caller's current authorization transaction. It writes no attention state. */
export function readAttention(frame: WorldFrame, valid: WorldValidQuery, now = new Date().toISOString()): AttentionRead {
  const scan = newReadFrame(frame.ctx, frame.ns, valid, frame.dependencies);
  const matches = readWorldMatches(scan, "situation", "", null, SCAN_LIMIT);
  const gaps = new Set<ViewGap>(matches.coverage.gaps), failures = new Set<"model_unavailable" | "provider_error">();
  const entries: AttentionEntry[] = [];
  if (matches.cursor !== null) gaps.add("traversal_limit");
  const observed = readSourceCoverage(frame.ctx).some(source => source.ingested > 0 && source.backfill_state !== "never_run");
  for (const match of matches.matches) {
    const handle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    if (handle === null) continue;
    const dependencies = worldDependencies(), work = newReadFrame(frame.ctx, frame.ns, valid, dependencies);
    const card = readWorldCard(work, handle, "situation") as SituationCard | null;
    if (card === null) continue;
    for (const gap of card.coverage.gaps) gaps.add(gap);
    const detailed = readWorldCard(work, handle, "situation", SITUATION_CARD_V2_SCHEMA) as SituationCardV2 | null;
    // V2 reports absence of optional commitment/decision records as coverage.
    // That absence does not make an otherwise complete goal/blocker unreadable.
    if (detailed !== null && detailed.commitments.length > 0)
      for (const gap of detailed.coverage.gaps) gaps.add(gap);
    // A failure is visible only for the exact permitted evidence basis.
    const basis = collectConsolidationBasis(work, handle, "situation");
    if (basis !== null && (card.coverage.gaps.includes("pending_consolidation") || card.coverage.gaps.includes("stale_dependencies"))) {
      const job = frame.ctx.db.query<{ outcome: string | null }, [string]>("SELECT outcome FROM world_consolidation_jobs WHERE basis_digest=?").get(basis.digest);
      if (job !== null && ["rejected", "truncated", "unavailable", "error"].includes(job.outcome ?? "")) failures.add("provider_error");
      else if (loadConfiguredModelRef(frame.ctx.vaultPath) === null) failures.add("model_unavailable");
    }
    mergeDependencies(frame.dependencies, dependencies);
    for (const cue of [...situationCues(card), ...(detailed === null ? [] : commitmentCues(detailed))]) {
      const cueKey = key(frame, cue, card.situation.ref.token);
      const stored = frame.ctx.db.query<{ disposition: AttentionCandidate["disposition"]; snoozed_until: string | null; delivered_at: string | null }, [string, string]>(
        "SELECT disposition,snoozed_until,delivered_at FROM world_attention_state WHERE namespace_id=? AND cue_key=?",
      ).get(frame.ns.id, cueKey);
      const expired = stored?.disposition === "snoozed" && (stored.snoozed_until === null || stored.snoozed_until <= now);
      const candidate: AttentionCandidate = issuedOpaqueFields({ state: "candidate", cue: cueKey, source: cue.source,
        subject: card.situation.ref, disposition: stored === null || expired ? "none" : stored.disposition,
        snoozedUntil: stored !== null && !expired && stored.disposition === "snoozed" ? stored.snoozed_until : null }, ["cue"]);
      const sources = basis?.pins.map(pin => pin.source) ?? dependencies.coverage?.sources ?? [];
      entries.push({ candidate, handle, dependencies, sources: [...new Set(sources)].sort(), deliveredAt: expired ? null : stored?.delivered_at ?? null });
    }
  }
  entries.sort((a, b) => order[a.candidate.source] - order[b.candidate.source] || a.candidate.cue.localeCompare(b.candidate.cue));
  if (entries.length > ATTENTION_CANDIDATE_LIMIT) gaps.add("traversal_limit");
  const selected = entries.slice(0, ATTENTION_CANDIDATE_LIMIT);
  const states = [...selected.map(entry => entry.candidate), ...attentionCoverageStates(gaps, observed, failures)];
  if (states.length === 0) states.push({ state: "quiet", reason: "no_material_change" });
  const data: Attention = { schema: ATTENTION_SCHEMA, states,
    coverage: { ...matches.coverage, status: gaps.size === 0 && observed ? "complete_for_query" : "partial", gaps: [...gaps, ...(!observed && !gaps.has("coverage") ? ["coverage" as const] : [])] } };
  if (!validateAttention(data).ok) throw new Error("attention projection is invalid");
  return { data, entries: selected };
}
