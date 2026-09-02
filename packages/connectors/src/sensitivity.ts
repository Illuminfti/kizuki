import type { SensitivityHint } from "@kizuki/core";

/** Least to most sensitive; the order the floor and a hint are compared in. */
const SENSITIVITY_ORDER: readonly SensitivityHint[] = [
  "public",
  "personal",
  "private",
];

export interface SensitivityPolicy {
  default_sensitivity: SensitivityHint;
  sensitivity_floor: SensitivityHint;
}

/**
 * The label a record carries, decided by the connector rather than asked of
 * the owner. A source's own hint is honored only upward: a claim below the
 * floor is raised to it instead of believed. Anything the policy cannot
 * place — no hint, or a value that is not a label — falls to the default, and
 * a source with no default at all is `private`, because a record whose
 * sensitivity is unknown must not be served more widely than one that said.
 */
export function resolveSensitivity(
  policy: Partial<SensitivityPolicy>,
  hint?: unknown,
): SensitivityHint {
  const floor = policy.sensitivity_floor ?? "private";
  const claimed = SENSITIVITY_ORDER.find((value) => value === hint);
  if (claimed === undefined) return policy.default_sensitivity ?? "private";
  return SENSITIVITY_ORDER.indexOf(claimed) < SENSITIVITY_ORDER.indexOf(floor)
    ? floor
    : claimed;
}
