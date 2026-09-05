import { archiveError } from "./errors";

const NATIVE_ID = /^[0-9]{1,20}$/;
const ARCHIVE_DATE =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2}) ([0-9]{4})$/;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function nativeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !NATIVE_ID.test(value)) {
    throw archiveError("parse_error", `${field} must be a native numeric X id`);
  }
  return value;
}

export function userSubjectId(id: string): string {
  return `x:user:${nativeId(id, "account id")}`;
}

export function postRecordId(id: string): string {
  return `post:${nativeId(id, "post id")}`;
}

/** Parse X's archive timestamp without Date.parse normalization or rollover. */
export function parseArchiveDate(value: unknown): string {
  if (typeof value !== "string") {
    throw archiveError("parse_error", "post created_at is missing or invalid");
  }
  const match = ARCHIVE_DATE.exec(value);
  if (match === null) {
    throw archiveError("parse_error", "post created_at is missing or invalid");
  }
  const [, weekday, monthName, dayText, hourText, minuteText, secondText,
    sign, offsetHourText, offsetMinuteText, yearText] = match;
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]);
  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (
    month < 0 || year < 2006 || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    (sign === "-" && offsetHour === 0 && offsetMinute === 0)
  ) {
    throw archiveError("parse_error", "post created_at is missing or invalid");
  }
  const local = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month ||
    local.getUTCDate() !== day || local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second ||
    WEEKDAYS[local.getUTCDay()] !== weekday
  ) {
    throw archiveError("parse_error", "post created_at is missing or invalid");
  }
  const offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
  const instant = local.getTime() - offsetMinutes * 60_000;
  const result = new Date(instant);
  if (!Number.isFinite(result.getTime())) {
    throw archiveError("parse_error", "post created_at is missing or invalid");
  }
  return result.toISOString();
}
