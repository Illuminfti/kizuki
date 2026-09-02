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
    const iso = new Date(normalized).toISOString();
    // A value can be well-formed and still leave the years RFC3339 covers once
    // it is in UTC, and the runtime writes an expanded year for it. The event
    // contract rejects that string, and the ingest runner keeps the previous
    // checkpoint whenever a batch reports an error, so one such row would stop
    // the source from ever advancing. Null routes it to the counted skip path.
    return isRfc3339(iso) ? iso : null;
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
  const shifted = new Date(Date.parse(base) + seconds * 1_000).toISOString();
  // Past year 9999 the runtime writes an expanded year, which is not RFC3339.
  // Such an event fails validation, and the runner keeps the checkpoint on any
  // error, so the batch would be re-read and rejected on every later call.
  return isRfc3339(shifted) ? shifted : base;
}
