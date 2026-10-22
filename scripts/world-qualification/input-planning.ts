import type { ProduceInputV2 } from "../../packages/core/src/contracts/producer-v2";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { modelProducerFingerprint, modelProducerInputTokenOverhead } from "../../packages/core/src/producer/fingerprint";
import { isPlainObject } from "../../packages/core/src/util/validate";
import { canonicalJson, sha256 } from "../evaluate-extraction";

export interface QualificationInputPolicy {
  readonly schema: "kizuki.qualification-input-policy/v1";
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly input_token_overhead: number;
}

export const DEFAULT_QUALIFICATION_INPUT_POLICY: QualificationInputPolicy = Object.freeze({
  schema: "kizuki.qualification-input-policy/v1", max_input_tokens: 8_192,
  max_output_tokens: 8_192, input_token_overhead: 0,
});

/** The trusted run policy is separate from the closed producer-v2 budget. */
export function validateQualificationInputPolicy(raw: unknown): QualificationInputPolicy {
  const keys = ["schema", "max_input_tokens", "max_output_tokens", "input_token_overhead"];
  if (!isPlainObject(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key)) ||
      raw.schema !== DEFAULT_QUALIFICATION_INPUT_POLICY.schema ||
      !Number.isSafeInteger(raw.max_input_tokens) || (raw.max_input_tokens as number) < 1 || (raw.max_input_tokens as number) > 32_000 ||
      !Number.isSafeInteger(raw.max_output_tokens) || (raw.max_output_tokens as number) < 1 || (raw.max_output_tokens as number) > 8_192 ||
      !Number.isSafeInteger(raw.input_token_overhead) || (raw.input_token_overhead as number) < 0 || (raw.input_token_overhead as number) > 32_000 ||
      (raw.input_token_overhead as number) >= (raw.max_input_tokens as number)) throw new Error("invalid qualification input policy");
  return Object.freeze({ schema: raw.schema, max_input_tokens: raw.max_input_tokens as number,
    max_output_tokens: raw.max_output_tokens as number, input_token_overhead: raw.input_token_overhead as number });
}

/** Rebuild from the actual production planner. Random fence bytes never enter this hash. */
export function qualificationInputPlanning(input: ProduceInputV2, rawPolicy: QualificationInputPolicy) {
  const policy = validateQualificationInputPolicy(rawPolicy);
  if (input.budget.max_calls !== 1 || input.budget.max_input_tokens !== policy.max_input_tokens ||
      input.budget.max_output_tokens !== policy.max_output_tokens) throw new Error("qualification planning budget mismatch");
  const plan = planModelExtractionV2(input, policy.input_token_overhead);
  if (plan.status !== "ready") throw new Error("qualification input planning rejected");
  const value = { schema: "kizuki.qualification-input-planning/v1" as const,
    outbound_sha256: sha256(canonicalJson(plan.outbound)), estimated_input_tokens: plan.input_tokens,
    input_token_overhead: plan.input_token_overhead, reserved_input_tokens: plan.reserved_input_tokens,
    max_input_tokens: policy.max_input_tokens, max_output_tokens: plan.max_output_tokens };
  return { ...value, planning_sha256: sha256(canonicalJson(value)) };
}

export type QualificationInputPlanning = ReturnType<typeof qualificationInputPlanning>;

/** A copied public property cannot attest a factory's live planning policy. */
export function qualificationProducerInputOverhead(producer: object, rawPolicy: QualificationInputPolicy): number {
  const policy = validateQualificationInputPolicy(rawPolicy), actual = modelProducerInputTokenOverhead(producer);
  if (modelProducerFingerprint(producer) === null || actual !== policy.input_token_overhead)
    throw new Error("qualification producer reservation mismatch");
  return actual;
}
