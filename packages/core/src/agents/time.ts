import { isRfc3339 } from "../util/time";

const COMPONENTS =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

interface Instant {
  epochSecond: number;
  fraction: string;
}

function instant(value: string, field: string): Instant {
  if (!isRfc3339(value)) {
    throw new TypeError(`${field}: must be an RFC3339 timestamp`);
  }
  const match = COMPONENTS.exec(value);
  if (match === null) {
    throw new TypeError(`${field}: timestamp could not be normalized`);
  }
  const date = new Date(0);
  const second = Number(match[6]);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(Number(match[4]), Number(match[5]), Math.min(second, 59), 0);
  let epochSecond = Math.trunc(date.getTime() / 1_000);
  if (second === 60) epochSecond += 1;

  const offsetSeconds = Number(match[10] ?? 0) * 3_600 + Number(match[11] ?? 0) * 60;
  if (match[9] === "+") epochSecond -= offsetSeconds;
  if (match[9] === "-") epochSecond += offsetSeconds;
  return { epochSecond, fraction: match[7] ?? "" };
}

export function compareRfc3339(
  left: string,
  leftField: string,
  right: string,
  rightField: string,
): number {
  const a = instant(left, leftField);
  const b = instant(right, rightField);
  if (a.epochSecond !== b.epochSecond) {
    return a.epochSecond < b.epochSecond ? -1 : 1;
  }
  const length = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = a.fraction.padEnd(length, "0");
  const bFraction = b.fraction.padEnd(length, "0");
  if (aFraction === bFraction) return 0;
  return aFraction < bFraction ? -1 : 1;
}

export function rfc3339Millis(value: string, field: string): number {
  const parsed = instant(value, field);
  const milliseconds = Number(`${parsed.fraction}000`.slice(0, 3));
  return parsed.epochSecond * 1_000 + milliseconds;
}
