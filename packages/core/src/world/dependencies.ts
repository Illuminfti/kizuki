import { identityReceiptCurrent } from "./identity-receipt";
import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./pipeline/eligible";
import { authorizedClaimSql } from "./policy-sql";
import { knownSupportSql, knownHeldSql, cutoffSequence, type KnownCutoff } from "./known/cutoff";
import { issueWorldRef, type WorldNamespace } from "./references";
import { sourceCoverage, type SourceCoverageGap } from "./coverage";

/** Complete authorized evidence used by a projection, including evidence omitted from its wire body. */
export interface WorldDependencies {
  readonly claims: Set<string>;
  cutoff?: KnownCutoff;
  /** A returned temporal capability can retain an older, byte-equivalent cutoff. */
  snapshot?: { readonly cutoff: KnownCutoff; readonly current: (ctx: ServeContext) => boolean };
  readonly supports: Set<string>;
  readonly events: Set<string>;
  /** Exact receipt ownership used to activate native identity, rechecked at publication. */
  readonly identityReceipts: Map<string, string>;
  /** Authorized sources and the completeness/backlog gaps observed during assembly. */
  coverage: { readonly sources: readonly string[]; readonly gaps: readonly SourceCoverageGap[] } | null;
}

export function worldDependencies(): WorldDependencies {
  return { claims: new Set(), supports: new Set(), events: new Set(), identityReceipts: new Map(), coverage: null };
}

export function recordWorldDependencies(deps: WorldDependencies, item: Eligible): void {
  deps.claims.add(item.claimId);
  for (const support of item.supports) {
    deps.supports.add(support.row.support_key);
    if (support.admission.schema === "kizuki.world-admission/v2") {
      for (const basis of support.admission.grounding) {
        deps.supports.add(basis.classification.support_key);
        deps.supports.add(basis.label.support_key);
      }
    }
    for (const event of support.events) deps.events.add(event.event_id);
  }
}

/** Bind the complete evidence closure to the existing erasure cascades, without adding another cache table. */
export function dependencyRefs(db: Database, ns: WorldNamespace, deps: WorldDependencies): string[] {
  return [
    ...[...deps.claims].map((id) => issueWorldRef(db, ns, "claim", id).token),
    ...[...deps.supports].map((id) => issueWorldRef(db, ns, "admission", id).token),
    ...[...deps.events].map((id) => issueWorldRef(db, ns, "event_version", id).token),
  ];
}

/** Validate one bounded evidence closure at its retained position and current authority. */
export function worldEvidenceCurrent(ctx: ServeContext, deps: WorldDependencies, cutoff = deps.cutoff): boolean {
  for (const [claim, receipt] of deps.identityReceipts) if (!identityReceiptCurrent(ctx.db, claim, receipt, cutoff)) return false;
  const permitted = knownSupportSql(ctx, cutoff);
  const claim = authorizedClaimSql(ctx), held = knownHeldSql(ctx, "base", cutoff);
  const retained = cutoff === undefined ? "base.status='live'" : `base.status<>'purged' AND EXISTS(SELECT 1 FROM claim_lifecycle_history kh WHERE kh.claim_id=base.claim_id AND kh.sequence<=${cutoffSequence(cutoff)})`;
  const claims = ctx.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM claims base WHERE base.claim_id IN (SELECT value FROM json_each(?))
    AND ${retained} AND ${claim.sql} AND NOT ${held.sql}`)
    .get(JSON.stringify([...deps.claims]), ...claim.bindings, ...held.bindings);
  if (claims?.n !== deps.claims.size) return false;
  const row = ctx.db.query<{ n: number }, (string | number)[]>(`
    SELECT count(*) AS n FROM claim_v2_support s
    WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${permitted.sql}
  `).get(JSON.stringify([...deps.supports]), ...permitted.bindings);
  return row?.n === deps.supports.size;
}

/** Revalidate evidence, retained capabilities and coverage without a global write epoch. */
export function worldDependenciesCurrent(ctx: ServeContext, deps: WorldDependencies): boolean {
  if (!worldEvidenceCurrent(ctx, deps)) return false;
  if (deps.snapshot !== undefined && (!deps.snapshot.current(ctx) || !worldEvidenceCurrent(ctx, deps, deps.snapshot.cutoff))) return false;
  if (deps.coverage === null) return true;
  const current = worldDependencies();
  sourceCoverage(ctx, current);
  return JSON.stringify(current.coverage) === JSON.stringify(deps.coverage);
}
