import { KizukiError, isPlainObject } from "@kizuki/core";
import type { Cursor } from "@kizuki/core";

export const ICS_CURSOR_SCHEMA = "kizuki.ics-cursor/v1" as const;
export const HASH_PREFIX_CHARS = 16;

export interface IcsCursor {
  schema: typeof ICS_CURSOR_SCHEMA;
  /** source_record_id → the first 16 hex characters of the event content hash. */
  records: Record<string, string>;
  etag?: string;
  last_modified?: string;
}

export function emptyIcsCursor(): IcsCursor {
  return { schema: ICS_CURSOR_SCHEMA, records: {} };
}

export function encodeIcsCursor(cursor: IcsCursor): Cursor {
  return JSON.stringify(cursor);
}

export function decodeIcsCursor(raw: Cursor): IcsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", "kizuki.ics: malformed cursor", {
      cause: error,
    });
  }
  if (!isPlainObject(parsed) || parsed["schema"] !== ICS_CURSOR_SCHEMA) {
    throw new KizukiError("parse_error", "kizuki.ics: invalid cursor schema");
  }
  const records = parsed["records"];
  if (!isPlainObject(records)) {
    throw new KizukiError("parse_error", "kizuki.ics: invalid cursor records");
  }
  const decoded: Record<string, string> = {};
  for (const [id, hash] of Object.entries(records)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{1,64}$/.test(hash)) {
      throw new KizukiError("parse_error", "kizuki.ics: invalid cursor hash");
    }
    decoded[id] = hash;
  }
  const etag = parsed["etag"];
  const lastModified = parsed["last_modified"];
  if (etag !== undefined && typeof etag !== "string") {
    throw new KizukiError("parse_error", "kizuki.ics: invalid cursor etag");
  }
  if (lastModified !== undefined && typeof lastModified !== "string") {
    throw new KizukiError(
      "parse_error",
      "kizuki.ics: invalid cursor last_modified",
    );
  }
  return {
    schema: ICS_CURSOR_SCHEMA,
    records: decoded,
    ...(typeof etag === "string" ? { etag } : {}),
    ...(typeof lastModified === "string" ? { last_modified: lastModified } : {}),
  };
}
