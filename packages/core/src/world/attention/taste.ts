import type { EvidenceRef, WorldWireRef } from "../../contracts/world-card-kit";
import { foldLabel } from "../pipeline/collect";

export type TasteStance = "accepted" | "rejected";
export type TasteUncertainty = "low" | "moderate" | "high" | "conflicted";

/**
 * Per-domain taste evidence record (A4).
 * Acceptance of an example is evidence about taste in one domain and context,
 * never a universal preference and never a canon approval queue.
 */
export interface TasteRecord {
  readonly id: string;
  readonly domain: string;
  readonly context: readonly string[];
  readonly stance: TasteStance;
  readonly exampleLabel: string;
  readonly exampleRef?: WorldWireRef<"object">;
  readonly claimRef?: WorldWireRef<"claim">;
  readonly reasons: readonly string[];
  readonly provenance: readonly EvidenceRef[];
  readonly observedAt: string | null;
  readonly sourceKey?: string;
  readonly independence?: "independent" | "dependent" | "unknown";
  readonly canonApprovalQueue?: false;
}

export interface TasteValidationResult {
  readonly ok: boolean;
  readonly reason:
    | null
    | "missing_domain"
    | "missing_example"
    | "missing_reasons"
    | "missing_provenance"
    | "invalid_stance"
    | "canon_queue_forbidden";
}

export interface GroundedTasteItem {
  readonly id: string;
  readonly domain: string;
  readonly context: readonly string[];
  readonly stance: TasteStance;
  readonly exampleLabel: string;
  readonly exampleRef: WorldWireRef<"object"> | null;
  readonly claimRef: WorldWireRef<"claim"> | null;
  readonly reasons: readonly string[];
  readonly provenance: readonly EvidenceRef[];
  readonly observedAt: string | null;
  readonly uncertainty: TasteUncertainty;
}

export interface DomainTasteProfile {
  readonly domain: string;
  readonly context: readonly string[];
  readonly status: "evidenced" | "unknown";
  readonly accepted: readonly GroundedTasteItem[];
  readonly rejected: readonly GroundedTasteItem[];
  readonly uncertainty: TasteUncertainty;
  readonly conflicts: readonly string[];
  readonly canonApprovalQueue: false;
  readonly excludedInvalidCount: number;
}

export function normalizeDomainKey(value: string): string {
  return foldLabel(value).trim();
}

export function validateTasteRecord(record: TasteRecord): TasteValidationResult {
  if (typeof record.domain !== "string" || normalizeDomainKey(record.domain).length === 0) {
    return { ok: false, reason: "missing_domain" };
  }
  if (typeof record.exampleLabel !== "string" || record.exampleLabel.trim().length === 0) {
    return { ok: false, reason: "missing_example" };
  }
  if (record.stance !== "accepted" && record.stance !== "rejected") {
    return { ok: false, reason: "invalid_stance" };
  }
  if (!Array.isArray(record.reasons) || record.reasons.every(reason => typeof reason !== "string" || reason.trim().length === 0)) {
    return { ok: false, reason: "missing_reasons" };
  }
  if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
    return { ok: false, reason: "missing_provenance" };
  }
  if ((record as { canonApprovalQueue?: unknown }).canonApprovalQueue === true) {
    return { ok: false, reason: "canon_queue_forbidden" };
  }
  return { ok: true, reason: null };
}

function itemUncertainty(record: TasteRecord, conflicted: boolean): TasteUncertainty {
  if (conflicted) return "conflicted";
  if (record.independence === "dependent" || record.independence === "unknown") return "high";
  const uniqueEvents = new Set(record.provenance.map(ref => ref.eventVersion.token));
  if (uniqueEvents.size >= 2) return "low";
  return "moderate";
}

function contextMatches(recordContext: readonly string[], targetContext: readonly string[]): boolean {
  if (targetContext.length === 0) return true;
  if (recordContext.length === 0) return false;
  const recordSet = new Set(recordContext.map(normalizeDomainKey).filter(Boolean));
  return targetContext.map(normalizeDomainKey).filter(Boolean).every(tag => recordSet.has(tag));
}

/**
 * Compile a strictly domain-scoped taste profile (A4).
 * Records from other domains never bleed across domain boundaries, missing
 * provenance excludes a record, and conflicts remain explicit.
 */
export function compileDomainTaste(
  records: readonly TasteRecord[],
  targetDomain: string,
  options: {
    readonly context?: readonly string[];
    readonly allowedSources?: ReadonlySet<string>;
    readonly allowedEventTokens?: ReadonlySet<string>;
  } = {},
): DomainTasteProfile {
  const domainKey = normalizeDomainKey(targetDomain);
  const targetContext = (options.context ?? []).map(tag => tag.trim()).filter(Boolean);
  const validDomainRecords: TasteRecord[] = [];
  let excludedInvalidCount = 0;

  for (const record of records) {
    if (!validateTasteRecord(record).ok) {
      excludedInvalidCount += 1;
      continue;
    }
    if (normalizeDomainKey(record.domain) !== domainKey) continue;
    if (!contextMatches(record.context, targetContext)) continue;
    if (options.allowedSources !== undefined && record.sourceKey !== undefined && !options.allowedSources.has(record.sourceKey)) {
      continue;
    }
    const permittedProvenance = options.allowedEventTokens === undefined
      ? record.provenance
      : record.provenance.filter(ref => options.allowedEventTokens!.has(ref.eventVersion.token));
    if (permittedProvenance.length === 0) continue;
    validDomainRecords.push({
      ...record,
      reasons: record.reasons.map(reason => reason.trim()).filter(Boolean),
      provenance: permittedProvenance,
    });
  }

  const stancesByExample = new Map<string, Set<TasteStance>>();
  for (const record of validDomainRecords) {
    const key = normalizeDomainKey(record.exampleLabel);
    const seen = stancesByExample.get(key) ?? new Set<TasteStance>();
    seen.add(record.stance);
    stancesByExample.set(key, seen);
  }

  const conflicts: string[] = [];
  for (const [exampleKey, stances] of stancesByExample) {
    if (stances.size > 1) conflicts.push(exampleKey);
  }
  conflicts.sort();
  const conflictSet = new Set(conflicts);

  const accepted: GroundedTasteItem[] = [];
  const rejected: GroundedTasteItem[] = [];
  for (const record of validDomainRecords) {
    const exampleKey = normalizeDomainKey(record.exampleLabel);
    const item: GroundedTasteItem = {
      id: record.id,
      domain: targetDomain,
      context: [...record.context],
      stance: record.stance,
      exampleLabel: record.exampleLabel.trim(),
      exampleRef: record.exampleRef ?? null,
      claimRef: record.claimRef ?? null,
      reasons: record.reasons,
      provenance: record.provenance,
      observedAt: record.observedAt,
      uncertainty: itemUncertainty(record, conflictSet.has(exampleKey)),
    };
    if (record.stance === "accepted") accepted.push(item);
    else rejected.push(item);
  }

  accepted.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.id.localeCompare(b.id));

  const totalItems = accepted.length + rejected.length;
  const uncertainty: TasteUncertainty = conflicts.length > 0
    ? "conflicted"
    : totalItems === 0
      ? "high"
      : [...accepted, ...rejected].every(item => item.uncertainty === "low")
        ? "low"
        : [...accepted, ...rejected].some(item => item.uncertainty === "high")
          ? "high"
          : "moderate";

  return {
    domain: targetDomain,
    context: targetContext,
    status: totalItems > 0 ? "evidenced" : "unknown",
    accepted,
    rejected,
    uncertainty,
    conflicts,
    canonApprovalQueue: false,
    excludedInvalidCount,
  };
}
