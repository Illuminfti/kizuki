import type { SensitivityHint } from "@kizuki/core";

/** Least to most sensitive; the order a floor and a hint are compared in. */
const SENSITIVITY_ORDER: readonly SensitivityHint[] = [
  "public",
  "personal",
  "private",
];

/**
 * What a connector declares about the records it produces. The pair is
 * carried on the manifest, where a host reads it when a connection is made.
 *
 * `kizuki.connector/v1` takes both fields as optional: making them required,
 * and failing a manifest without them in the shared conformance suite, is a
 * change every connector in the tree has to answer at once, and it belongs
 * with that change rather than beside three importers. Until then this
 * resolver fails closed on a policy that declares nothing.
 */
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
