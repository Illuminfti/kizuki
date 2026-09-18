import { isPlainObject, KizukiError } from "@kizuki/core";

export const BEEPER_CURSOR_SCHEMA = "kizuki.beeper-cursor/v1" as const;

/** `backfill` still walks history backward; `sync` polls forward from `after`. */
export type BeeperPhase = "backfill" | "sync";

export interface BeeperCursor {
  schema: typeof BEEPER_CURSOR_SCHEMA;
  phase: BeeperPhase;
  /** Oldest point already walked; null starts the backward walk at the newest page. */
  before: string | null;
  /** Newest point already observed; null means no forward anchor is known yet. */
  after: string | null;
}

const KEYS = ["schema", "phase", "before", "after"] as const;

export function parseBeeperCursor(raw: string): BeeperCursor {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw malformed(); }
  if (!isPlainObject(value) || value.schema !== BEEPER_CURSOR_SCHEMA) throw malformed();
  const keys = Object.keys(value);
  // Checkpoints written before the forward poll existed carry one backward point.
  if (keys.length === 2 && Object.hasOwn(value, "cursor")) {
    if (!validPoint(value.cursor)) throw malformed();
    return { schema: BEEPER_CURSOR_SCHEMA, phase: "backfill", before: value.cursor, after: null };
  }
  if (keys.length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(value, key)) || !isPhase(value.phase) || !optionalPoint(value.before) || !optionalPoint(value.after)) throw malformed();
  // A forward poll has left the backward walk behind; carrying both is ambiguous.
  if (value.phase === "sync" && value.before !== null) throw malformed();
  return { schema: BEEPER_CURSOR_SCHEMA, phase: value.phase, before: value.before, after: value.after };
}

export function encodeBeeperCursor(cursor: Omit<BeeperCursor, "schema">): string {
  if (!isPhase(cursor.phase) || !optionalPoint(cursor.before) || !optionalPoint(cursor.after) || (cursor.phase === "sync" && cursor.before !== null)) throw malformed();
  return JSON.stringify({ schema: BEEPER_CURSOR_SCHEMA, phase: cursor.phase, before: cursor.before, after: cursor.after });
}

function isPhase(value: unknown): value is BeeperPhase { return value === "backfill" || value === "sync"; }

function optionalPoint(value: unknown): value is string | null { return value === null || validPoint(value); }

function validPoint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 8 * 1024;
}

function malformed(): KizukiError { return new KizukiError("parse_error", "kizuki.beeper: malformed cursor"); }
