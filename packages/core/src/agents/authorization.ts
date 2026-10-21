import { compareRfc3339, rfc3339Millis } from "./time";
import { SENSITIVITY_ORDER, denyClassesOf } from "./types";
import type {
  DenyReason,
  Grant,
  Sensitivity,
  Servable,
  Tool,
} from "./types";

type Authorization = { allow: true } | { allow: false; reason: DenyReason };

/** The lattice or nothing: an unrecognized label is outside it, not below it. */
export function sensitivity(value: unknown): Sensitivity | null {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, value)
  ) {
    return null;
  }
  return value as Sensitivity;
}

export function authorize(grant: Grant, item: Servable): Authorization {
  if (item.held === true) return { allow: false, reason: "held" };

  const label = sensitivity(item.sensitivity);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  if (SENSITIVITY_ORDER[label] > SENSITIVITY_ORDER[grant.ceiling]) {
    return { allow: false, reason: "above_ceiling" };
  }

  if (item.classes !== undefined) {
    const denied = denyClassesOf(grant);
    if (item.classes.some((name) => (denied as readonly string[]).includes(name))) {
      return { allow: false, reason: "class_denied" };
    }
  }

  if (
    grant.types !== null &&
    (item.type === undefined || !grant.types.includes(item.type))
  ) {
    return { allow: false, reason: "type_out_of_scope" };
  }

  if (grant.subjects !== null) {
    const subjectMatch =
      item.subjects !== undefined &&
      item.subjects.some((subject) => grant.subjects?.includes(subject));
    if (!subjectMatch) {
      return { allow: false, reason: "subject_out_of_scope" };
    }
  }

  if (grant.since !== null || grant.until !== null) {
    const span =
      item.occurred_span ??
      (item.occurred_at === undefined
        ? undefined
        : { from: item.occurred_at, to: item.occurred_at });
    if (span === undefined) {
      return { allow: false, reason: "time_out_of_scope" };
    }
    try {
      rfc3339Millis(span.from, "occurred_at");
      rfc3339Millis(span.to, "occurred_at");
    } catch {
      return { allow: false, reason: "time_out_of_scope" };
    }
    if (
      (grant.since !== null &&
        compareRfc3339(span.from, "occurred_at", grant.since, "since") < 0) ||
      (grant.until !== null &&
        compareRfc3339(span.to, "occurred_at", grant.until, "until") > 0)
    ) {
      return { allow: false, reason: "time_out_of_scope" };
    }
  }

  return { allow: true };
}

export function filterServable<T extends Servable>(
  grant: Grant,
  items: T[],
): { served: T[]; denied: { id: string; reason: DenyReason }[] } {
  const served: T[] = [];
  const denied: { id: string; reason: DenyReason }[] = [];
  for (const item of items) {
    const result = authorize(grant, item);
    if (result.allow) served.push(item);
    else denied.push({ id: item.id, reason: result.reason });
  }
  return { served, denied };
}

export function toolAllowed(grant: Grant, tool: Tool): boolean {
  return grant.tools.includes(tool);
}
