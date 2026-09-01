import { rfc3339Millis } from "./time";
import { SENSITIVITY_ORDER } from "./types";
import type {
  DenyReason,
  Grant,
  Sensitivity,
  Servable,
  Tool,
} from "./types";

type Authorization = { allow: true } | { allow: false; reason: DenyReason };

function sensitivity(value: string | null | undefined): Sensitivity | null {
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
    if (item.occurred_at === undefined) {
      return { allow: false, reason: "time_out_of_scope" };
    }
    let occurredAt: number;
    try {
      occurredAt = rfc3339Millis(item.occurred_at, "occurred_at");
    } catch {
      return { allow: false, reason: "time_out_of_scope" };
    }
    if (
      (grant.since !== null &&
        occurredAt < rfc3339Millis(grant.since, "since")) ||
      (grant.until !== null &&
        occurredAt > rfc3339Millis(grant.until, "until"))
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
