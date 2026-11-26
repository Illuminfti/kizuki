import { canonicalJson, sha256Hex } from "../util/hash";
import { readDurableObservation } from "../claims/observations";
import { forecastFingerprint } from "./forecast/fingerprint";
import { claimReader, claimPublicationFingerprint } from "../serving/claims";
import { getClaim } from "../claims/store";
import { identityReceiptCurrent } from "./identity-receipt";
import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./pipeline/eligible";
import { heldClaimSql } from "./corroboration";
import { authorizedClaimSql } from "./policy-sql";
import { knownSupportSql, knownHeldSql, cutoffSequence, type KnownCutoff } from "./known/cutoff";
import { issueWorldRef, type WorldNamespace } from "./references";
import { sourceCoverage, type SourceCoverageGap } from "./coverage";

export type DependencyWeightClass =
  | "owner_assertion"
  | "independent_evidence"
  | "cross_domain_link"
  | "dependent_copy"
  | "generated_summary";

export const DEPENDENCY_WEIGHTS: Readonly<Record<DependencyWeightClass, number>> = Object.freeze({
  owner_assertion: 1.0,
  independent_evidence: 0.75,
  cross_domain_link: 0.5,
  dependent_copy: 0.0,
  generated_summary: 0.0,
});

export interface DependencyWeightEntry {
  readonly key: string;
  readonly kind: "claim" | "support" | "event" | "consolidation";
  readonly weightClass: DependencyWeightClass;
  readonly weight?: number;
  readonly observedAt: string | null;
}

export interface EffectiveDependencyWeight {
  readonly totalWeight: number;
  readonly independentWeight: number;
  readonly independentCount: number;
  readonly dependentCopyCount: number;
  readonly summaryReplayCount: number;
  readonly entryCount: number;
}

/** Complete authorized evidence used by a projection, including evidence omitted from its wire body. */
export interface WorldDependencies {
  /** Independent guards for bounded operation composition; never overwrite a sibling baseline. */
  readonly children: WorldDependencies[];
  readonly claims: Set<string>;
  readonly observations: Map<string, string>;
  readonly forecasts: Map<string,{readonly fingerprint:string;readonly resolution:boolean}>;
  readonly legacyClaims: Map<string, string>;
  cutoff?: KnownCutoff;
  /** A returned temporal capability can retain an older, byte-equivalent cutoff. */
  snapshot?: { readonly cutoff: KnownCutoff; readonly current: (ctx: ServeContext) => boolean };
  /** A conditional result also depends on the continued authority of its retained baseline. */
  priorView?: { readonly current: (ctx: ServeContext) => boolean };
  readonly supports: Set<string>;
  readonly events: Set<string>;
  /** Exact receipt ownership used to activate native identity, rechecked at publication. */
  readonly identityReceipts: Map<string, string>;
  /** Exact retained summary records used by a card; rebuild/expiry wins at publication. */
  readonly consolidations: Map<string, { responseHash: string; completedAt: string; expiresAt: string }>;
  /** Authorized sources and the completeness/backlog gaps observed during assembly. */
  coverage: { readonly sources: readonly string[]; readonly gaps: readonly SourceCoverageGap[] } | null;
  /** Optional bounded evidence weights used by adaptive domain salience and depth accounting. */
  weights?: Map<string, DependencyWeightEntry>;
}

export function worldDependencies(): WorldDependencies {
  return { children: [], forecasts: new Map(), observations: new Map(), claims: new Set(), legacyClaims: new Map(), supports: new Set(), events: new Set(), identityReceipts: new Map(), consolidations: new Map(), coverage: null };
}

function normalizedDependencyWeight(entry: DependencyWeightEntry): number {
  if (entry.weightClass === "dependent_copy" || entry.weightClass === "generated_summary") return 0;
  const raw = entry.weight ?? DEPENDENCY_WEIGHTS[entry.weightClass];
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

/** Record one weighted evidence entry. Copies and generated summary replays never gain positive weight. */
export function recordDependencyWeight(deps: WorldDependencies, entry: DependencyWeightEntry): void {
  const weights = deps.weights ?? (deps.weights = new Map());
  const nextWeight = normalizedDependencyWeight(entry);
  const existing = weights.get(entry.key);
  if (existing === undefined) {
    weights.set(entry.key, { ...entry, weight: nextWeight });
    return;
  }
  const existingWeight = normalizedDependencyWeight(existing);
  if (nextWeight > existingWeight) {
    weights.set(entry.key, { ...entry, weight: nextWeight });
  }
}

/** Attach a bounded child dependency closure without exceeding the composition ceiling. */
export function mergeWorldDependencies(target: WorldDependencies, child: WorldDependencies): void {
  if (target.children.length >= 32) throw new Error("world dependency composition limit");
  target.children.push(child);
}

function collectDependencyWeights(
  deps: WorldDependencies,
  out: Map<string, DependencyWeightEntry>,
  depth: number,
): void {
  if (depth > 2 || deps.children.length > 32) throw new Error("world dependency composition limit");
  if (deps.weights !== undefined) {
    for (const [key, entry] of deps.weights) {
      const prior = out.get(key);
      if (prior === undefined || normalizedDependencyWeight(entry) > normalizedDependencyWeight(prior)) {
        out.set(key, entry);
      }
    }
  }
  for (const child of deps.children) collectDependencyWeights(child, out, depth + 1);
}

/**
 * Aggregate deduplicated dependency weights across a bounded closure.
 * Dependent copies and generated summaries contribute zero weight so replay never inflates depth.
 */
export function effectiveDependencyWeight(
  deps: WorldDependencies,
  options: { readonly now?: string; readonly halfLifeDays?: number } = {},
): EffectiveDependencyWeight {
  const deduped = new Map<string, DependencyWeightEntry>();
  collectDependencyWeights(deps, deduped, 0);
  const nowMs = options.now !== undefined ? Date.parse(options.now) : Number.NaN;
  const halfLife = options.halfLifeDays !== undefined && Number.isFinite(options.halfLifeDays) && options.halfLifeDays > 0
    ? options.halfLifeDays
    : null;
  let totalWeight = 0;
  let independentWeight = 0;
  let independentCount = 0;
  let dependentCopyCount = 0;
  let summaryReplayCount = 0;
  for (const entry of deduped.values()) {
    if (entry.weightClass === "dependent_copy") {
      dependentCopyCount += 1;
      continue;
    }
    if (entry.weightClass === "generated_summary") {
      summaryReplayCount += 1;
      continue;
    }
    const base = normalizedDependencyWeight(entry);
    let factor = 1;
    if (halfLife !== null && Number.isFinite(nowMs) && entry.observedAt !== null) {
      const observedMs = Date.parse(entry.observedAt);
      if (Number.isFinite(observedMs)) {
        const ageDays = Math.max(0, (nowMs - observedMs) / 86_400_000);
        factor = Math.pow(0.5, ageDays / halfLife);
      }
    }
    const weighted = base * factor;
    totalWeight += weighted;
    if (entry.weightClass === "owner_assertion" || entry.weightClass === "independent_evidence") {
      independentWeight += weighted;
      independentCount += 1;
    }
  }
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return {
    totalWeight: round(totalWeight),
    independentWeight: round(independentWeight),
    independentCount,
    dependentCopyCount,
    summaryReplayCount,
    entryCount: deduped.size,
  };
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
export function dependencyRefs(db: Database, ns: WorldNamespace, deps: WorldDependencies, depth = 0): string[] {
  if (depth > 2 || deps.children.length > 32) throw new Error("world dependency composition limit");
  return [...new Set([
    ...[...deps.legacyClaims.keys(), ...deps.claims].map((id) => issueWorldRef(db, ns, "claim", id).token),
    ...[...deps.supports].map((id) => issueWorldRef(db, ns, "admission", id).token),
    ...[...deps.events].map((id) => issueWorldRef(db, ns, "event_version", id).token),
    ...deps.children.flatMap(child => dependencyRefs(db, ns, child, depth + 1)),
  ])];
}

/** Validate one bounded evidence closure at its retained position and current authority. */
export function worldEvidenceCurrent(ctx: ServeContext, deps: WorldDependencies, cutoff = deps.cutoff): boolean {
  for (const [id, hash] of deps.observations) {
    const observation = readDurableObservation(ctx.db, id);
    if (observation === null || sha256Hex(canonicalJson(observation.record)) !== hash) return false;
  }
  for (const [id,pin] of deps.forecasts) if (forecastFingerprint(ctx.db,id,pin.resolution)!==pin.fingerprint) return false;
  for (const [basis, summary] of deps.consolidations) {
    const row = ctx.db.query<{ response_hash: string; completed_at: string; expires_at: string }, [string]>(
      "SELECT response_hash,completed_at,expires_at FROM world_consolidation WHERE basis_digest=? AND status='complete'",
    ).get(basis);
    if (row === null || row.response_hash !== summary.responseHash || row.completed_at !== summary.completedAt || row.expires_at !== summary.expiresAt || row.expires_at <= new Date().toISOString()) return false;
  }
  if (deps.legacyClaims.size > 0) {
    const legacy = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" });
    for (const [id, fingerprint] of deps.legacyClaims) {
      const claim = getClaim(ctx.db, id);
      if (claim === null || claim.status !== "live" || !legacy.canRead(claim) || claimPublicationFingerprint(claim) !== fingerprint) return false;
    }
  }
  for (const [claim, receipt] of deps.identityReceipts) if (!identityReceiptCurrent(ctx.db, claim, receipt, cutoff)) return false;
  const permitted = deps.claims.size > 0 || deps.supports.size > 0 ? knownSupportSql(ctx, cutoff) : null;
  if (deps.claims.size > 0) {
    const claim = authorizedClaimSql(ctx);
    const held = cutoff === undefined ? heldClaimSql("base", permitted!) : knownHeldSql(ctx, "base", cutoff);
    const retained = cutoff === undefined ? "base.status='live'" : `base.status<>'purged' AND EXISTS(SELECT 1 FROM claim_lifecycle_history kh WHERE kh.claim_id=base.claim_id AND kh.sequence<=${cutoffSequence(cutoff)})`;
    const claims = ctx.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM claims base WHERE base.claim_id IN (SELECT value FROM json_each(?))
      AND ${retained} AND ${claim.sql} AND NOT ${held.sql}`)
      .get(JSON.stringify([...deps.claims]), ...claim.bindings, ...held.bindings);
    if (claims?.n !== deps.claims.size) return false;
  }
  if (deps.supports.size === 0) return true;
  const row = ctx.db.query<{ n: number }, (string | number)[]>(`
    SELECT count(*) AS n FROM claim_v2_support s
    WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${permitted!.sql}
  `).get(JSON.stringify([...deps.supports]), ...permitted!.bindings);
  return row?.n === deps.supports.size;
}

/** Revalidate evidence, retained capabilities and coverage without a global write epoch. */
export function worldDependenciesCurrent(ctx: ServeContext, deps: WorldDependencies, depth = 0): boolean {
  if (depth > 2 || deps.children.length > 32 || deps.children.some(child => !worldDependenciesCurrent(ctx, child, depth + 1))) return false;
  if (deps.priorView !== undefined && !deps.priorView.current(ctx)) return false;
  if (!worldEvidenceCurrent(ctx, deps)) return false;
  if (deps.snapshot !== undefined && (!deps.snapshot.current(ctx) || !worldEvidenceCurrent(ctx, deps, deps.snapshot.cutoff))) return false;
  if (deps.coverage === null) return true;
  const current = worldDependencies();
  sourceCoverage(ctx, current);
  return JSON.stringify(current.coverage) === JSON.stringify(deps.coverage);
}
