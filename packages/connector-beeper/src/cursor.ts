import { isPlainObject, KizukiError } from "@kizuki/core";

export const BEEPER_CURSOR_SCHEMA = "kizuki.beeper-cursor/v1" as const;

export interface BeeperCursor {
  schema: typeof BEEPER_CURSOR_SCHEMA;
  cursor: string;
}

export function parseBeeperCursor(raw: string): BeeperCursor {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw malformed(); }
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.schema !== BEEPER_CURSOR_SCHEMA || !validCursor(value.cursor)) throw malformed();
  return { schema: BEEPER_CURSOR_SCHEMA, cursor: value.cursor };
}

export function encodeBeeperCursor(cursor: string): string {
  if (!validCursor(cursor)) throw malformed();
  return JSON.stringify({ schema: BEEPER_CURSOR_SCHEMA, cursor });
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 8 * 1024;
}

function malformed(): KizukiError { return new KizukiError("parse_error", "kizuki.beeper: malformed cursor"); }
