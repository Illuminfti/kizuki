import { randomBytes } from "node:crypto";
import type { HistoryPage, StateTransition } from "../../contracts/world-history";
import { validateHistoryPage } from "../../contracts/world-history";
import { compareRfc3339 } from "../../agents/time";
import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { worldDependencies, recordWorldDependencies } from "../dependencies";
import { heldClaimSql } from "../corroboration";
import { authorizedClaimSql, validMeaningSql } from "../policy-sql";
import { anchorOf } from "../pipeline/collect";
import { eligibleWorldClaim } from "../pipeline/eligible";
import { coverageOf } from "../pipeline/assemble";
import { newReadFrame, WorldProjectionBudgetError } from "../pipeline/frame";
import { projectWorldCard } from "../projection";
import { issueWorldRef } from "../references";
import { coveredOutcome, NOT_FOUND } from "../ops/outcome";
import type { WorldFrame, WorldWhen, WorldOpOutcome } from "../ops/types";
import { issueKnownSnapshot, lookupKnownSnapshot } from "./snapshots";
import { knownSupportSql, resolveKnownTime, WorldHistoryUnavailable, type KnownCutoff } from "./cutoff";

function scopedClaims(frame: WorldFrame, handle: string) {
  const anchor = anchorOf(frame.ctx.db, handle);
  if (anchor === null) return null;
  const claim = authorizedClaimSql(frame.ctx), permitted = knownSupportSql(frame.ctx), held = heldClaimSql("base", permitted);
  return { sql: `FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    WHERE base.status<>'purged' AND c.discriminator='assertion' AND ${claim.sql}
    AND ((c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?)
      OR (json_extract(c.payload,'$.object.ref.kind')=? AND json_extract(c.payload,'$.object.ref.id')=? AND coalesce(json_extract(c.payload,'$.object.ref.namespace'),'')=?))
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}`,
    bindings: [...claim.bindings, anchor.kind, anchor.id, rawSubjectNamespace(anchor), anchor.kind, anchor.id, rawSubjectNamespace(anchor), ...permitted.bindings, ...held.bindings] };
}
/** Complete later admissions prove absence. Baselines cannot prove an earlier past. */
function checkCoverage(frame: WorldFrame, handle: string, cutoff: KnownCutoff): boolean {
  const scope = scopedClaims(frame, handle);
  if (scope === null) return false;
  const gap = frame.ctx.db.query(`SELECT 1 ${scope.sql} AND (
    NOT EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id)
    OR EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id AND kc.coverage='baseline_only' AND kc.complete_from_sequence>?)) LIMIT 1`)
    .get(...scope.bindings, cutoff.sequence);
  if (gap !== null) throw new WorldHistoryUnavailable();
  return frame.ctx.db.query(`SELECT 1 ${scope.sql} AND EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id AND kc.coverage='baseline_only') LIMIT 1`).get(...scope.bindings) !== null;
}
function resolve(frame: WorldFrame, handle: string, when: WorldWhen): KnownCutoff | null {
  const cutoff = when.knownAt.kind === "snapshot"
    ? lookupKnownSnapshot(frame.ctx, frame.ns, when.knownAt.ref, handle, when.valid)
    : frame.dependencies?.cutoff ?? (when.knownAt.kind === "time" ? resolveKnownTime(frame.ctx.db, when.knownAt.at)
    : (() => { const row = frame.ctx.db.query<{ last_recorded_at: string; last_sequence: number }, []>("SELECT last_recorded_at,last_sequence FROM claim_history_clock WHERE id=1").get()!; return { at: row.last_recorded_at, sequence: row.last_sequence }; })());
  if (cutoff !== null && frame.dependencies !== undefined) frame.dependencies.cutoff = cutoff;
  return cutoff;
}
function snapshot(frame: WorldFrame, handle: string, when: WorldWhen, cutoff: KnownCutoff, reserveView: boolean) {
  return when.knownAt.kind === "snapshot" ? when.knownAt.ref
    : issueKnownSnapshot(frame.ctx, frame.ns, { cutoff, handle, valid: when.valid, reserveView }, frame.dependencies ?? worldDependencies());
}
export function readKnownCard(frame: WorldFrame, handle: string, kind: "concept" | "situation", when: WorldWhen): WorldOpOutcome {
  if (when.knownAt.kind === "current") {
    const card = projectWorldCard(frame.ctx, frame.ns, handle, kind, when.valid, frame.dependencies);
    return card === null ? NOT_FOUND : coveredOutcome(card);
  }
  const cutoff = resolve(frame, handle, when);
  if (cutoff === null) return { status: "new_view_required" };
  let baseline: boolean;
  try { baseline = checkCoverage(frame, handle, cutoff); } catch (error) {
    if (error instanceof WorldHistoryUnavailable && when.knownAt.kind === "snapshot") return { status: "new_view_required" };
    throw error;
  }
  if (frame.dependencies !== undefined) frame.dependencies.cutoff = cutoff;
  const card = projectWorldCard(frame.ctx, frame.ns, handle, kind, when.valid, frame.dependencies, { kind: "recorded", ...cutoff });
  if (card === null) return NOT_FOUND;
  const ref = snapshot(frame, handle, when, cutoff, card.coverage.status === "complete_for_query");
  if (ref === null) return { status: "unavailable", reason: "history" };
  return coveredOutcome({ ...card, knownAt: { kind: "snapshot", ref }, coverage: { ...card.coverage, history: baseline ? "baseline_only" : "retained_for_query" } });
}
function publicStatus(status: string | null): StateTransition["before"] {
  return status === null ? "absent" : status === "live" ? "active" : status === "superseded" ? "superseded" : "retracted";
}
function receiptRef(frame: WorldFrame, claimId: string, receiptId: string | null) {
  if (receiptId === null || frame.ctx.db.query("SELECT 1 FROM canon_receipts WHERE receipt_id=?").get(receiptId) === null) return null;
  const old = frame.ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_known_receipt_refs WHERE namespace_id=? AND receipt_id=? LIMIT 1").get(frame.ns.id, receiptId);
  let token = old?.wire_ref;
  if (token === undefined) {
    do { token = randomBytes(32).toString("base64url"); }
    while (frame.ctx.db.query("SELECT 1 FROM world_known_receipt_refs WHERE namespace_id=? AND wire_ref=?").get(frame.ns.id, token) !== null);
  }
  // One receipt identity may be witnessed by several authorized transitions.
  // Each claim retains its own erasure edge to the shared opaque identity.
  frame.ctx.db.query("INSERT OR IGNORE INTO world_known_receipt_refs(namespace_id,claim_id,receipt_id,wire_ref) VALUES (?,?,?,?)").run(frame.ns.id, claimId, receiptId, token);
  return { kind: "receipt" as const, token };
}
export function readKnownHistory(frame: WorldFrame, handle: string, when: WorldWhen): WorldOpOutcome {
  const cutoff = resolve(frame, handle, when);
  if (cutoff === null) return { status: "new_view_required" };
  let baseline: boolean;
  try { baseline = checkCoverage(frame, handle, cutoff); } catch (error) {
    if (error instanceof WorldHistoryUnavailable && when.knownAt.kind === "snapshot") return { status: "new_view_required" };
    throw error;
  }
  const scope = scopedClaims(frame, handle);
  if (scope === null) return NOT_FOUND;
  const deps = frame.dependencies ?? worldDependencies(); deps.cutoff = cutoff;
  const read = newReadFrame(frame.ctx, frame.ns, when.valid, deps, { kind: "recorded", ...cutoff });
  // Only records whose complete currently authorized support existed by the
  // cutoff compete for this bounded page. Hidden or later evidence uses no slot.
  const permitted = knownSupportSql(frame.ctx, cutoff), held = heldClaimSql("base", permitted);
  const classifications = frame.ctx.db.query<{ claim_id: string }, (string | number)[]>(
    `SELECT c.claim_id ${scope.sql} AND c.predicate='world.kind' AND c.polarity='positive'
      AND json_extract(c.payload,'$.perspective.mode')='asserted'
      AND json_extract(c.payload,'$.object.kind')='vocabulary' AND json_extract(c.payload,'$.object.ref.id')='world/concept'
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}
      ORDER BY c.claim_id LIMIT 129`,
  ).all(...scope.bindings, ...permitted.bindings, ...held.bindings);
  if (classifications.length > 128) throw new WorldProjectionBudgetError();
  let classified = false;
  for (const row of classifications) {
    const item = eligibleWorldClaim(frame.ctx, row.claim_id, { kind: "all" }, read.budget, { cutoff, includeInactive: true });
    if (item !== null) { recordWorldDependencies(deps, item); classified = true; break; }
  }
  if (!classified) return NOT_FOUND;
  const time = validMeaningSql(when.valid, "hc");
  const historyTime = time.sql.replaceAll("hc.valid_to", "h.valid_to");
  const rows = frame.ctx.db.query<{
    claim_id: string; sequence: number; recorded_at: string; receipt_id: string | null;
    before_status: string | null; after_status: string; valid_to: string | null;
  }, (string | number)[]>(`SELECT h.* FROM claim_lifecycle_history h JOIN claim_v2_semantics hc ON hc.claim_id=h.claim_id WHERE h.sequence<=? AND h.support_key IS NULL AND ${historyTime}
    AND h.claim_id IN (SELECT c.claim_id ${scope.sql} AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql})
    ORDER BY h.sequence LIMIT 129`).all(cutoff.sequence, ...time.bindings, ...scope.bindings, ...permitted.bindings, ...held.bindings);
  const transitions: StateTransition[] = [];
  let overflow = false;
  for (const row of rows) {
    const item = eligibleWorldClaim(frame.ctx, row.claim_id, { kind: "all" }, read.budget, { cutoff, includeInactive: true });
    if (item === null) continue;
    const meaning = { ...item.semantic, valid_to: row.valid_to };
    if (meaning.temporal_basis !== "unknown" && meaning.valid_from !== null && row.valid_to !== null && compareRfc3339(row.valid_to, "until", meaning.valid_from, "from") <= 0) throw new WorldHistoryUnavailable();
    const time = meaning.temporal_basis === "unknown" || meaning.valid_from === null ? { kind: "unknown" as const } : { kind: "known" as const, from: meaning.valid_from, until: row.valid_to };
    if (when.valid.kind === "unknown_only" && time.kind !== "unknown") continue;
    if (when.valid.kind === "at" && (time.kind === "unknown" || compareRfc3339(time.from, "from", when.valid.at, "at") > 0 || (time.until !== null && compareRfc3339(when.valid.at, "at", time.until, "until") >= 0))) continue;
    if (when.valid.kind === "overlap" && (time.kind === "unknown" || compareRfc3339(time.from, "from", when.valid.until, "until") >= 0 || (time.until !== null && compareRfc3339(time.until, "until", when.valid.from, "from") <= 0))) continue;
    if (transitions.length === 128) { overflow = true; break; }
    recordWorldDependencies(deps, item);
    transitions.push({ schema: "kizuki.state-transition/v1", claim: issueWorldRef(frame.ctx.db, frame.ns, "claim", row.claim_id),
      causeReceipt: receiptRef(frame, row.claim_id, row.receipt_id), recordedAt: row.recorded_at,
      before: publicStatus(row.before_status), after: publicStatus(row.after_status) as StateTransition["after"], valid: time });
  }
  if (transitions.length === 0) return NOT_FOUND;
  const coverage = { ...coverageOf(read, overflow), history: baseline ? "baseline_only" as const : "retained_for_query" as const };
  const ref = snapshot({ ...frame, dependencies: deps }, handle, when, cutoff, coverage.status === "complete_for_query");
  if (ref === null) return { status: "unavailable", reason: "history" };
  const page: HistoryPage = { schema: "kizuki.world-history/v1", snapshot: ref, transitions,
    coverage };
  if (!validateHistoryPage(page).ok) throw new WorldHistoryUnavailable();
  return coveredOutcome(page);
}
