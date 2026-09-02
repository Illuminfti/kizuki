import { raiseSensitivity } from "@kizuki/core";
import type { PageSensitivity } from "@kizuki/core";

/**
 * Both importers read an export of the owner's own estate: files, notes and
 * message archives. RFC 0002 §8.2 puts that source class at default `private`,
 * floor `personal`. The floor is what makes a mapping honest — a previous
 * system's `public` described its reach, not Kizuki's serving layer — and
 * §8.1 puts anything unknown or unparseable at `private`.
 */

export const LEGACY_DEFAULT_SENSITIVITY: PageSensitivity = "private";
export const LEGACY_SENSITIVITY_FLOOR: PageSensitivity = "personal";

/** The label a legacy source may actually emit: never below the floor. */
export function atLegacyFloor(label: PageSensitivity): PageSensitivity {
  return raiseSensitivity(LEGACY_SENSITIVITY_FLOOR, label);
}
