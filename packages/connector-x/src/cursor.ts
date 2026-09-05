import { MAX_CURSOR_BYTES, isPlainObject } from "@kizuki/core";
import { archiveError } from "./errors";
import { nativeId } from "./ids";

export const X_ARCHIVE_CURSOR_SCHEMA = "kizuki.import-x-archive.cursor/v1" as const;
const HASH = /^[0-9a-f]{64}$/;

export interface XArchiveCursor {
  schema: typeof X_ARCHIVE_CURSOR_SCHEMA;
  account_id: string;
  snapshot_sha256: string;
  next_part: number | null;
  next_record: number | null;
  seen_records: number;
}

export function encodeCursor(cursor: XArchiveCursor): string {
  return JSON.stringify(cursor);
}

export function parseCursor(value: string): XArchiveCursor {
  if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) {
    throw archiveError("parse_error", "cursor is malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw archiveError("parse_error", "cursor is malformed", error);
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).sort().join(",") !==
    "account_id,next_part,next_record,schema,seen_records,snapshot_sha256") {
    throw archiveError("parse_error", "cursor is malformed");
  }
  const nextPart = parsed["next_part"];
  const nextRecord = parsed["next_record"];
  const seen = parsed["seen_records"];
  if (
    parsed["schema"] !== X_ARCHIVE_CURSOR_SCHEMA ||
    typeof parsed["snapshot_sha256"] !== "string" ||
    !HASH.test(parsed["snapshot_sha256"]) ||
    !Number.isSafeInteger(seen) || (seen as number) < 0 ||
    !((nextPart === null && nextRecord === null) ||
      (Number.isSafeInteger(nextPart) && (nextPart as number) >= 0 &&
        Number.isSafeInteger(nextRecord) && (nextRecord as number) >= 0))
  ) {
    throw archiveError("parse_error", "cursor is malformed");
  }
  return {
    schema: X_ARCHIVE_CURSOR_SCHEMA,
    account_id: nativeId(parsed["account_id"], "cursor account id"),
    snapshot_sha256: parsed["snapshot_sha256"],
    next_part: nextPart as number | null,
    next_record: nextRecord as number | null,
    seen_records: seen as number,
  };
}
