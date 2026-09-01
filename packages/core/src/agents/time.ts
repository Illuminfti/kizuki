import { isRfc3339 } from "../util/time";

export function rfc3339Millis(value: string, field: string): number {
  if (!isRfc3339(value)) {
    throw new TypeError(`${field}: must be an RFC3339 timestamp`);
  }
  const leapSecond = /:60(?=(?:\.\d+)?(?:[zZ]|[+-]\d{2}:\d{2})$)/.test(value);
  const adjusted = leapSecond ? value.replace(":60", ":59") : value;
  const parsed = Date.parse(adjusted);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field}: timestamp could not be normalized`);
  }
  return parsed + (leapSecond ? 1_000 : 0);
}
