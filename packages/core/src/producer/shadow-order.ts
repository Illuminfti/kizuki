import type { SystemOneResponse } from "../contracts/systemone";

/** One named shadow workload. Not admission, not a serving tool, not a second contract. */
export const SHADOW_ORDER_WORKLOAD = "evidence-candidate-order" as const;

const MAX_CANDIDATES = 8;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class ShadowOrderError extends Error {
  readonly code: "unsupported" | "model_mismatch" | "incomplete";

  constructor(code: ShadowOrderError["code"], message: string) {
    super(message);
    this.name = "ShadowOrderError";
    this.code = code;
  }
}

export type ShadowDisagreement = {
  readonly id: string;
  readonly native_rank: number;
  readonly shadow_rank: number;
};

export type ShadowOrderReport = {
  readonly workload: typeof SHADOW_ORDER_WORKLOAD;
  readonly pinned_backend: string;
  readonly pinned_model: string;
  readonly observed_model: string | "unrun";
  readonly native_order: readonly string[];
  readonly shadow_order: readonly string[] | null;
  readonly disagreements: readonly ShadowDisagreement[];
  readonly evidence: "retained";
  readonly admission: "unchanged";
  readonly canon: "unchanged";
  readonly sensitivity: "unchanged";
  readonly grants: "unchanged";
  readonly actions: "none";
  readonly upstream_score: "not_inherited";
};

type ReportInput = {
  readonly workload: typeof SHADOW_ORDER_WORKLOAD;
  readonly pinned_backend: string;
  readonly pinned_model: string;
  readonly candidate_ids: readonly string[];
  readonly response: SystemOneResponse | null;
};

function refuse(code: ShadowOrderError["code"], message: string): never {
  throw new ShadowOrderError(code, message);
}

function label(name: string, value: unknown): string {
  if (typeof value !== "string" || !LABEL.test(value)) {
    refuse("unsupported", `${name} is not a bounded identity`);
  }
  return value;
}

function candidateIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES) {
    refuse("unsupported", "candidate ids must be a bounded list");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ID.test(item) || seen.has(item)) {
      refuse("unsupported", "candidate id is not a unique bounded identity");
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function report(
  pinnedBackend: string,
  pinnedModel: string,
  observedModel: string | "unrun",
  nativeOrder: readonly string[],
  shadowOrder: readonly string[] | null,
  disagreements: readonly ShadowDisagreement[],
): ShadowOrderReport {
  return {
    workload: SHADOW_ORDER_WORKLOAD,
    pinned_backend: pinnedBackend,
    pinned_model: pinnedModel,
    observed_model: observedModel,
    native_order: nativeOrder,
    shadow_order: shadowOrder,
    disagreements,
    evidence: "retained",
    admission: "unchanged",
    canon: "unchanged",
    sensitivity: "unchanged",
    grants: "unchanged",
    actions: "none",
    upstream_score: "not_inherited",
  };
}

function finiteScore(response: SystemOneResponse, id: string): number {
  const answer = response.answers[id];
  if (
    answer === undefined ||
    answer.type !== "score" ||
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score)
  ) {
    refuse("incomplete", "each candidate needs one finite score");
  }
  return answer.score;
}

/**
 * Compare a caller-supplied score response with a stable id order.
 * A missing response stays unrun. A different model is refused.
 * The report keeps every id and changes nothing else.
 */
export function reportShadowOrder(input: ReportInput): ShadowOrderReport {
  if (input.workload !== SHADOW_ORDER_WORKLOAD) {
    refuse("unsupported", "workload is not the named shadow case");
  }
  const pinnedBackend = label("pinned_backend", input.pinned_backend);
  const pinnedModel = label("pinned_model", input.pinned_model);
  const ids = candidateIds(input.candidate_ids);
  const nativeOrder = [...ids].sort((left, right) => left.localeCompare(right));
  if (input.response === null) {
    return report(pinnedBackend, pinnedModel, "unrun", nativeOrder, null, []);
  }
  if (pinnedBackend === "unconfigured") {
    refuse("unsupported", "an absent adapter cannot supply a shadow");
  }
  const response = input.response;
  if (typeof response.model !== "string" || response.model !== pinnedModel) {
    refuse("model_mismatch", "shadow model must be the pinned model");
  }
  if (typeof response.answers !== "object" || response.answers === null) {
    refuse("incomplete", "each candidate needs one finite score");
  }
  const allowed = new Set(ids);
  for (const key of Object.keys(response.answers)) {
    if (!allowed.has(key)) refuse("incomplete", "a shadow answer names an unknown candidate");
  }
  for (const id of ids) finiteScore(response, id);
  const shadowOrder = [...ids].sort((left, right) => {
    const delta = finiteScore(response, right) - finiteScore(response, left);
    if (delta !== 0) return delta;
    return left.localeCompare(right);
  });
  const nativeRank = new Map(nativeOrder.map((id, rank) => [id, rank]));
  const shadowRank = new Map(shadowOrder.map((id, rank) => [id, rank]));
  const disagreements = [...ids]
    .filter((id) => nativeRank.get(id) !== shadowRank.get(id))
    .sort((left, right) => left.localeCompare(right))
    .map((id) => {
      const native = nativeRank.get(id);
      const shadow = shadowRank.get(id);
      if (native === undefined || shadow === undefined) {
        refuse("incomplete", "rank is missing");
      }
      return { id, native_rank: native, shadow_rank: shadow };
    });
  return report(pinnedBackend, pinnedModel, response.model, nativeOrder, shadowOrder, disagreements);
}
