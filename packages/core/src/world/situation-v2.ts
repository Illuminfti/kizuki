import { dependencyPerspective, isSituationDependency } from "./situation-cycle";
import { activeWorldRegistry } from "../contracts/world-vocabulary";
import { SITUATION_DEPENDENCIES, type CommitmentEntry, type DecisionEntry, type SituationCardV2, type SituationDependency } from "../contracts/situation-card-v2";
import type { Relation, ViewGap } from "../contracts/world-card-kit";
import { exactCommitmentDue } from "../contracts/world-vocab/commitment";
import { canonicalizeRfc3339Utc } from "../util/time";
import { compareRfc3339 } from "../agents/time";
import { checkKnownCoverage } from "./known/coverage";
import { identityReceiptCurrent } from "./identity-receipt";
import { COLLECTORS, collectCard } from "./pipeline/collect";
import { enrich, type CardBody } from "./pipeline/enrich";
import { ENRICHERS } from "./pipeline/enrichers";
import type { ReadFrame } from "./pipeline/frame";
import type { Cluster } from "./pipeline/group";
import { coverageOf } from "./pipeline/assemble";
import { issueWorldRef, resolveWorldObject } from "./references";

export interface SituationDetails {
  readonly commitments: readonly CommitmentEntry[];
  readonly decisions: readonly DecisionEntry[];
  readonly dependencies: readonly SituationDependency[];
  readonly uncertainty: readonly Relation[];
  readonly gaps: readonly ViewGap[];
}
export const isAsserted = (r: Relation) => r.polarity === "positive" && r.perspective.mode === "asserted";
function overdue(due: readonly Relation[], complete: boolean, frame: ReadFrame): CommitmentEntry["overdue"] {
  if (!complete || due.length === 0 || due.some(r => r.polarity !== "positive" || !["asserted","reported","quoted"].includes(r.perspective.mode))) return "unknown";
  const values = due.map(r => r.object.kind === "literal" && exactCommitmentDue(r.object.value) ? r.object.value : null);
  if (values.some(v => v === null)) return "unknown";
  const normalized = new Set(values.map(v => v!.length === 10 ? v : canonicalizeRfc3339Utc(v!)));
  if (normalized.size !== 1) return "unknown";
  const value = values[0]!;
  const at = frame.valid.kind === "at" ? frame.valid.at : frame.valid.kind === "all"
    ? frame.cutoff.kind === "recorded" ? frame.cutoff.at : new Date().toISOString() : null;
  if (at === null) return "unknown";
  // A date has no timezone. Only a later UTC calendar date is safely overdue;
  // the date itself never becomes overdue at an invented midnight deadline.
  return value.length === 10 ? canonicalizeRfc3339Utc(at)!.slice(0,10) > value : compareRfc3339(at,"at",value,"due") > 0;
}

/** Nested records use the same bounded collector and eligibility pipeline as the outer card. */
export function collectSituationDetails(frame: ReadFrame, cluster: Cluster, body: CardBody): SituationDetails {
  const ownToken = issueWorldRef(frame.ctx.db,frame.ns,"object",cluster.anchor).token;
  const own = body.claims.map(c => c.relation).filter(r => r.subject.token === ownToken);
  const gaps = new Set<ViewGap>();
  const uncertainty: Relation[] = [];
  const cache = new Map<string, CardBody | null>();
  let visited = 0;
  const read = (token: string, kind: string): CardBody | null => {
    const key = `${kind}:${token}`;
    if (cache.has(key)) return cache.get(key)!;
    const handle = resolveWorldObject(frame.ctx.db,frame.ns,token), spec = activeWorldRegistry().kind(kind);
    if (handle === null || spec === undefined) return null;
    if (++visited > 32) { gaps.add("traversal_limit"); return null; }
    if (frame.cutoff.kind === "recorded" && checkKnownCoverage(frame.ctx,handle,frame.cutoff)) frame.historyBaseline = true;
    // Commitments/decisions are primitive identities; Concept convergence cannot merge their dates or status.
    const nested = { anchor: handle, members: [handle], resolution: "distinct" as const };
    const collected = collectCard(frame,nested,spec,COLLECTORS);
    const result = collected === null ? null : enrich(frame,collected.items,ENRICHERS,collected.overflow);
    cache.set(key,result);
    if (result?.overflow) gaps.add("traversal_limit");
    for (const gap of result?.gaps ?? []) gaps.add(gap);
    return result;
  };
  const rows = (data: CardBody, token: string) => data.claims.filter(c => c.relation.subject.token === token);
  const connected = (predicate: string) => [...new Map(own.filter(r => r.predicate === predicate && isAsserted(r) && r.object.kind === "node")
    .map(r => [r.object.kind === "node" ? r.object.ref.token : "",r] as const)).entries()];
  const commitments: CommitmentEntry[] = [];
  for (const [token, link] of connected("situation.has_commitment")) {
    if (link.object.kind !== "node") continue;
    const data = read(token,"commitment"); if (data === null) continue;
    const items = rows(data,token), relations = items.map(c => c.relation);
    const by = (predicate: string) => relations.filter(r => r.predicate === predicate);
    const parties = (predicate: string) => by(predicate).filter(r => r.object.kind === "node" && read(r.object.ref.token,"person") !== null);
    const statuses = by("commitment.status").filter(isAsserted);
    const authoritativeDone = items.some(c => c.relation.predicate === "commitment.status" && isAsserted(c.relation)
      && c.relation.object.kind === "vocabulary" && c.relation.object.id === "commitment/done"
      && c.eligible.supports.some(s => s.row.support_origin === "native_owner" && s.admission.epistemicKind === "owner_assertion"
        && ["owner_correction","owner_authored"].includes(s.admission.authority))
      && (() => { const id = frame.ctx.db.query<{receipt_id:string|null},[string]>("SELECT receipt_id FROM claims WHERE claim_id=?").get(c.eligible.claimId)?.receipt_id;
        if (!id || !identityReceiptCurrent(frame.ctx.db,c.eligible.claimId,id,frame.cutoff.kind === "current" ? undefined : frame.cutoff)) return false;
        frame.dependencies?.identityReceipts.set(c.eligible.claimId,id); return true; })());
    const values = new Set(statuses.flatMap(r => r.object.kind === "vocabulary" ? [r.object.id] : []));
    let status: CommitmentEntry["status"] = values.size === 1 && values.has("commitment/dropped") ? "dropped"
      : values.has("commitment/done") || values.has("commitment/claimed_done") ? "claimed_done" : "open";
    if (authoritativeDone && !values.has("commitment/dropped") && !values.has("commitment/open")) status = "done";
    if (values.size > 1) uncertainty.push(...statuses);
    uncertainty.push(...relations.filter(r => !isAsserted(r)));
    const labels = by("commitment.label").filter(isAsserted);
    commitments.push({ commitment: link.object.ref, label: labels.length === 1 ? labels[0]! : null,
      debtor: parties("commitment.debtor"), creditor: parties("commitment.creditor"), due: by("commitment.due"), deliverable: by("commitment.deliverable"),
      status, statusBasis: statuses.map(r => r.claim), overdue: "unknown" });
  }
  const decisions: DecisionEntry[] = [];
  for (const [token, link] of connected("situation.has_decision")) {
    if (link.object.kind !== "node") continue;
    const data = read(token,"decision"); if (data === null) continue;
    const relations = rows(data,token).map(c => c.relation);
    const labels = relations.filter(r => r.predicate === "decision.label" && isAsserted(r));
    const statuses = relations.filter(r => r.predicate === "decision.status");
    for (const statement of statuses) {
      if (!isAsserted(statement) || statement.object.kind !== "vocabulary") { uncertainty.push(statement); continue; }
      const status = statement.object.id.slice("decision/".length);
      if (status === "open" || status === "decided" || status === "reversed") decisions.push({ decision: link.object.ref, label: labels.length === 1 ? labels[0]! : null, status, statement });
    }
  }
  const dependencies: SituationDependency[] = [];
  let walked = 0;
  const cycles = (token: string, path: readonly string[], perspective: string): boolean => {
    if (++walked > 128) { gaps.add("traversal_limit"); return false; }
    if (path.includes(token)) return true;
    const data = read(token,"situation"); if (data === null) return false;
    return rows(data,token).some(c => isAsserted(c.relation) && isSituationDependency(c.relation.predicate)
      && c.relation.object.kind === "node" && dependencyPerspective(c.eligible.semantic) === perspective
      && cycles(c.relation.object.ref.token,[...path,token],perspective));
  };
  for (const relation of own) {
    if (!SITUATION_DEPENDENCIES.includes(relation.predicate as SituationDependency["predicate"]) || !isAsserted(relation)) continue;
    if (relation.object.kind !== "node") { uncertainty.push(relation); continue; }
    const token = relation.object.ref.token;
    const target = ["situation","commitment","decision"].some(kind => read(token,kind) !== null);
    if (target && isSituationDependency(relation.predicate)) {
      const original = body.claims.find(c => c.relation === relation)!;
      if (cycles(token,[ownToken],dependencyPerspective(original.eligible.semantic))) { gaps.add("stale_dependencies"); continue; }
    }
    if (target) dependencies.push({ predicate: relation.predicate as SituationDependency["predicate"], from: relation.subject, to: relation.object.ref, relation });
  }
  if (commitments.length === 0 && decisions.length === 0) gaps.add("coverage");
  const complete = coverageOf(frame,body.overflow === true,[...body.gaps,...gaps]).status === "complete_for_query";
  return { commitments: commitments.map(c => ({...c,overdue: overdue(c.due,complete,frame)})), decisions, dependencies, uncertainty, gaps: [...gaps] };
}
