import type { EvidenceRef } from "../../contracts/world-card-kit";
import { inspectSourceGrant, type SourcePurpose } from "../../ledger/source-grants";
import { loadConfiguredModelRef } from "../../serve/config";
import type { ServeContext } from "../../serving/types";

export interface ExpansionBudget {
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  readonly maxWrites: number;
  readonly maxDepth: number;
}

export interface ExpansionCost {
  readonly modelCalls: number;
  readonly tokens: number;
  readonly writes: number;
  readonly depthDelta: number;
}

export interface ExpansionPolicy {
  readonly configuredSources: readonly string[];
  readonly configuredModelEndpoint: string | null;
  readonly requiredPurpose?: SourcePurpose;
  readonly minSalience: number;
  readonly minIndependentSignals: number;
  readonly budget: ExpansionBudget;
}

export type ExpansionStopReason =
  | "owner_stopped"
  | "interest_retracted"
  | "insufficient_interest"
  | "coverage_incomplete"
  | "depth_ceiling_reached"
  | "budget_exhausted"
  | "write_budget_exhausted"
  | "unconfigured_source"
  | "missing_source_permission"
  | "unconfigured_model";

export interface ExpansionTrigger {
  readonly domain: string;
  readonly salience: number;
  readonly independentCount: number;
  readonly stage: "retracted" | "hypothesis" | "developing" | "sustained";
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ExpansionReceipt {
  readonly receiptId: string;
  readonly domain: string;
  readonly trigger: ExpansionTrigger;
  readonly sources: readonly string[];
  readonly modelEndpoint: string | null;
  readonly cost: ExpansionCost;
  readonly recordedAt: string;
  readonly undoneAt: string | null;
}

export interface ExpansionStopRecord {
  readonly domain: string;
  readonly reason: string;
  readonly stoppedAt: string;
}

export interface ExpansionExpenditure {
  readonly modelCallsUsed: number;
  readonly modelCallsLimit: number;
  readonly tokensUsed: number;
  readonly tokensLimit: number;
  readonly writesUsed: number;
  readonly writesLimit: number;
  readonly depthUsed: number;
  readonly depthCeiling: number;
}

export interface ExpansionLedger {
  readonly policy: ExpansionPolicy;
  readonly stops: Map<string, ExpansionStopRecord>;
  readonly receipts: ExpansionReceipt[];
  modelCallsUsed: number;
  tokensUsed: number;
  writesUsed: number;
  depthUsedByDomain: Map<string, number>;
}

export interface ExpansionRequest {
  readonly trigger: ExpansionTrigger;
  readonly candidateSources: readonly string[];
  readonly requiresModel: boolean;
  readonly coverageComplete: boolean;
  readonly estimatedCost: ExpansionCost;
}

export interface ExpansionDecision {
  readonly status: "permitted" | "stopped";
  readonly stopReason: ExpansionStopReason | null;
  readonly trigger: ExpansionTrigger;
  readonly allowedSources: readonly string[];
  readonly rejectedSources: readonly { readonly sourceKey: string; readonly reason: "unconfigured_source" | "missing_source_permission" }[];
  readonly modelEndpoint: string | null;
  readonly estimatedCost: ExpansionCost;
  readonly remainingBudget: ExpansionBudget;
  readonly expenditure: ExpansionExpenditure;
  readonly receiptIds: readonly string[];
  readonly silentConnectorActivation: false;
}

export function createExpansionLedger(policy: ExpansionPolicy): ExpansionLedger {
  return {
    policy: {
      ...policy,
      configuredSources: [...new Set(policy.configuredSources)].sort(),
      budget: {
        maxModelCalls: Math.max(0, Math.floor(policy.budget.maxModelCalls)),
        maxTokens: Math.max(0, Math.floor(policy.budget.maxTokens)),
        maxWrites: Math.max(0, Math.floor(policy.budget.maxWrites)),
        maxDepth: Math.max(0, Math.floor(policy.budget.maxDepth)),
      },
    },
    stops: new Map(),
    receipts: [],
    modelCallsUsed: 0,
    tokensUsed: 0,
    writesUsed: 0,
    depthUsedByDomain: new Map(),
  };
}

export function expansionExpenditure(ledger: ExpansionLedger, domain: string): ExpansionExpenditure {
  return {
    modelCallsUsed: ledger.modelCallsUsed,
    modelCallsLimit: ledger.policy.budget.maxModelCalls,
    tokensUsed: ledger.tokensUsed,
    tokensLimit: ledger.policy.budget.maxTokens,
    writesUsed: ledger.writesUsed,
    writesLimit: ledger.policy.budget.maxWrites,
    depthUsed: ledger.depthUsedByDomain.get(domain) ?? 0,
    depthCeiling: ledger.policy.budget.maxDepth,
  };
}

function remainingBudget(ledger: ExpansionLedger, domain: string): ExpansionBudget {
  const depthUsed = ledger.depthUsedByDomain.get(domain) ?? 0;
  return {
    maxModelCalls: Math.max(0, ledger.policy.budget.maxModelCalls - ledger.modelCallsUsed),
    maxTokens: Math.max(0, ledger.policy.budget.maxTokens - ledger.tokensUsed),
    maxWrites: Math.max(0, ledger.policy.budget.maxWrites - ledger.writesUsed),
    maxDepth: Math.max(0, ledger.policy.budget.maxDepth - depthUsed),
  };
}

/**
 * Deterministic bounded expansion gate (A3 & A7).
 * Never enables a connector, never spends beyond declared resource or write
 * budgets, and never bypasses owner stops or active source grants.
 */
export function evaluateDomainExpansion(
  ctx: Pick<ServeContext, "db" | "vaultPath">,
  ledger: ExpansionLedger,
  request: ExpansionRequest,
): ExpansionDecision {
  const domain = request.trigger.domain;
  const expenditure = expansionExpenditure(ledger, domain);
  const remaining = remainingBudget(ledger, domain);
  const receiptIds = ledger.receipts.filter(r => r.domain === domain && r.undoneAt === null).map(r => r.receiptId);
  const configuredSet = new Set(ledger.policy.configuredSources);
  const requiredPurpose = ledger.policy.requiredPurpose ?? "extract";

  const allowedSources: string[] = [];
  const rejectedSources: { readonly sourceKey: string; readonly reason: "unconfigured_source" | "missing_source_permission" }[] = [];
  for (const sourceKey of [...new Set(request.candidateSources)].sort()) {
    if (!configuredSet.has(sourceKey)) {
      rejectedSources.push({ sourceKey, reason: "unconfigured_source" });
      continue;
    }
    const grant = inspectSourceGrant(ctx.db, sourceKey);
    if (grant === null || grant.status !== "active" || !grant.policy.purposes.includes(requiredPurpose)) {
      rejectedSources.push({ sourceKey, reason: "missing_source_permission" });
      continue;
    }
    allowedSources.push(sourceKey);
  }

  const vaultModel = loadConfiguredModelRef(ctx.vaultPath);
  const modelEndpoint = request.requiresModel
    ? (ledger.policy.configuredModelEndpoint !== null && vaultModel !== null ? ledger.policy.configuredModelEndpoint : null)
    : ledger.policy.configuredModelEndpoint;

  const stop = (stopReason: ExpansionStopReason): ExpansionDecision => ({
    status: "stopped",
    stopReason,
    trigger: request.trigger,
    allowedSources,
    rejectedSources,
    modelEndpoint,
    estimatedCost: request.estimatedCost,
    remainingBudget: remaining,
    expenditure,
    receiptIds,
    silentConnectorActivation: false,
  });

  if (ledger.stops.has(domain)) return stop("owner_stopped");
  if (request.trigger.stage === "retracted") return stop("interest_retracted");
  if (
    request.trigger.stage === "hypothesis" ||
    request.trigger.independentCount < ledger.policy.minIndependentSignals ||
    request.trigger.salience < ledger.policy.minSalience
  ) {
    return stop("insufficient_interest");
  }
  if (!request.coverageComplete) return stop("coverage_incomplete");
  if (expenditure.depthUsed + request.estimatedCost.depthDelta > ledger.policy.budget.maxDepth) {
    return stop("depth_ceiling_reached");
  }
  if (ledger.writesUsed + request.estimatedCost.writes > ledger.policy.budget.maxWrites) {
    return stop("write_budget_exhausted");
  }
  if (
    ledger.modelCallsUsed + request.estimatedCost.modelCalls > ledger.policy.budget.maxModelCalls ||
    ledger.tokensUsed + request.estimatedCost.tokens > ledger.policy.budget.maxTokens
  ) {
    return stop("budget_exhausted");
  }
  if (allowedSources.length === 0) {
    const hasPermissionFailure = rejectedSources.some(item => item.reason === "missing_source_permission");
    return stop(hasPermissionFailure ? "missing_source_permission" : "unconfigured_source");
  }
  if (request.requiresModel && modelEndpoint === null) {
    return stop("unconfigured_model");
  }

  return {
    status: "permitted",
    stopReason: null,
    trigger: request.trigger,
    allowedSources,
    rejectedSources,
    modelEndpoint,
    estimatedCost: request.estimatedCost,
    remainingBudget: remaining,
    expenditure,
    receiptIds,
    silentConnectorActivation: false,
  };
}

/** Commit an authorized expansion step into the ledger, enforcing hard budget caps. */
export function recordExpansionStep(
  ledger: ExpansionLedger,
  receipt: Omit<ExpansionReceipt, "undoneAt">,
): ExpansionReceipt {
  const domain = receipt.domain;
  if (ledger.stops.has(domain)) throw new Error("expansion is stopped by owner");
  const currentDepth = ledger.depthUsedByDomain.get(domain) ?? 0;
  if (currentDepth + receipt.cost.depthDelta > ledger.policy.budget.maxDepth) {
    throw new Error("expansion depth ceiling exceeded");
  }
  if (ledger.writesUsed + receipt.cost.writes > ledger.policy.budget.maxWrites) {
    throw new Error("expansion write budget exceeded");
  }
  if (
    ledger.modelCallsUsed + receipt.cost.modelCalls > ledger.policy.budget.maxModelCalls ||
    ledger.tokensUsed + receipt.cost.tokens > ledger.policy.budget.maxTokens
  ) {
    throw new Error("expansion resource budget exceeded");
  }
  ledger.modelCallsUsed += receipt.cost.modelCalls;
  ledger.tokensUsed += receipt.cost.tokens;
  ledger.writesUsed += receipt.cost.writes;
  ledger.depthUsedByDomain.set(domain, currentDepth + receipt.cost.depthDelta);
  const stored: ExpansionReceipt = { ...receipt, undoneAt: null };
  ledger.receipts.push(stored);
  return stored;
}

/** Owner stop halts further expansion for a domain while keeping inspect, correct and undo open. */
export function stopDomainExpansion(
  ledger: ExpansionLedger,
  domain: string,
  reason: string,
  stoppedAt: string = new Date().toISOString(),
): ExpansionStopRecord {
  const record: ExpansionStopRecord = { domain, reason: reason.trim() || "owner_stop", stoppedAt };
  ledger.stops.set(domain, record);
  return record;
}

/** Record receipted undo of a prior expansion write while preserving the audit receipt trail. */
export function undoExpansionReceipt(
  ledger: ExpansionLedger,
  receiptId: string,
  undoneAt: string = new Date().toISOString(),
): ExpansionReceipt | null {
  const index = ledger.receipts.findIndex(item => item.receiptId === receiptId);
  if (index < 0) return null;
  const existing = ledger.receipts[index]!;
  if (existing.undoneAt !== null) return existing;
  const updated: ExpansionReceipt = { ...existing, undoneAt };
  ledger.receipts[index] = updated;
  const depthUsed = ledger.depthUsedByDomain.get(existing.domain) ?? 0;
  ledger.depthUsedByDomain.set(existing.domain, Math.max(0, depthUsed - existing.cost.depthDelta));
  return updated;
}
