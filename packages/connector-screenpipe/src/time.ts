import { isRfc3339 } from "@kizuki/core";

const LEGACY_SQLX =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

export function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  let normalized = raw;
  if (!isRfc3339(normalized)) {
    const match = LEGACY_SQLX.exec(raw);
    if (match === null) return null;
    const date = match[1];
    const hoursAndMinutes = match[2];
    if (date === undefined || hoursAndMinutes === undefined) return null;
    normalized =
      `${date}T${hoursAndMinutes}${match[3] ?? ":00"}` +
      `${match[4] ?? "Z"}`;
    if (!isRfc3339(normalized)) return null;
  }

  try {
    return new Date(normalized).toISOString();
  } catch {
    return null;
  }
}

export function offsetSeconds(base: string, seconds: unknown): string {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds >= 86_400
  ) {
    return base;
  }
  return new Date(Date.parse(base) + seconds * 1_000).toISOString();
}
