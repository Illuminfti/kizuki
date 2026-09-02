import { SENSITIVITY_ORDER, isSensitivity } from "../agents/types";
import type { Sensitivity } from "../agents/types";

export type SensitivityRefinement = "none" | "applied" | "rejected_downward";

export interface ResolveSensitivityInput {
  connector_floor?: unknown;
  connector_default?: unknown;
  /** Producer or model estimate; applied only upward. */
  model_label?: unknown;
  /** Event `sensitivity_hint`; honored only upward. */
  event_hint?: unknown;
  owner_label?: unknown;
  /** Owner correction may set the label directly, including downward. */
  owner_override?: boolean;
}

export interface SensitivityResolution {
  sensitivity: Sensitivity;
  refinement: SensitivityRefinement;
  hint_ignored: boolean;
  owner_override: boolean;
}

export function parseSensitivity(value: unknown): Sensitivity | null {
  return isSensitivity(value) ? value : null;
}

/** Unknown, absent, or unparseable at any step resolves to private (RFC 0002 §8.1). */
export function sensitivityOrPrivate(value: unknown): Sensitivity {
  return parseSensitivity(value) ?? "private";
}

export function stricter(
  left: Sensitivity,
  right: Sensitivity,
): Sensitivity {
  return SENSITIVITY_ORDER[left] >= SENSITIVITY_ORDER[right] ? left : right;
}

/**
 * `sensitivity = max(connector_floor, connector_default_or_model_label, owner_label)`
 * over `public < personal < private`. Refinement may only move up, except an
 * owner correction (`owner_override`).
 */
export function resolveSensitivity(
  input: ResolveSensitivityInput,
): SensitivityResolution {
  if (input.owner_override === true) {
    const owner = parseSensitivity(input.owner_label);
    if (owner !== null) {
      return {
        sensitivity: owner,
        refinement: "none",
        hint_ignored: false,
        owner_override: true,
      };
    }
  }

  const floor = sensitivityOrPrivate(input.connector_floor);
  const connectorDefault = sensitivityOrPrivate(input.connector_default);
  let candidate = connectorDefault;
  let refinement: SensitivityRefinement = "none";

  const model = parseSensitivity(input.model_label);
  if (model !== null) {
    if (SENSITIVITY_ORDER[model] > SENSITIVITY_ORDER[candidate]) {
      candidate = model;
      refinement = "applied";
    } else if (SENSITIVITY_ORDER[model] < SENSITIVITY_ORDER[candidate]) {
      refinement = "rejected_downward";
    }
  }

  let hintIgnored = false;
  const hint = parseSensitivity(input.event_hint);
  if (hint !== null) {
    if (SENSITIVITY_ORDER[hint] > SENSITIVITY_ORDER[candidate]) {
      candidate = hint;
    } else if (SENSITIVITY_ORDER[hint] < SENSITIVITY_ORDER[candidate]) {
      hintIgnored = true;
    }
  }

  const owner = parseSensitivity(input.owner_label);
  if (owner !== null && SENSITIVITY_ORDER[owner] > SENSITIVITY_ORDER[candidate]) {
    candidate = owner;
  }

  return {
    sensitivity: stricter(floor, candidate),
    refinement,
    hint_ignored: hintIgnored,
    owner_override: false,
  };
}
