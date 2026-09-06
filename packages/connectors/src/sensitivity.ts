import { resolveSensitivity as resolveCoreSensitivity } from "@kizuki/core";
import type { SensitivityHint } from "@kizuki/core";

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
 * Connector helper kept at `(policy, hint?)` for existing callers. Delegates
 * to core `max(floor, default, upward event hint)`; a valid hint may only
 * raise the connector default, and unknown or absent values fail closed to
 * private.
 */
export function resolveSensitivity(
  policy: Partial<SensitivityPolicy>,
  hint?: unknown,
): SensitivityHint {
  return resolveCoreSensitivity({
    connector_floor: policy.sensitivity_floor,
    connector_default: policy.default_sensitivity,
    event_hint: hint,
  }).sensitivity;
}
