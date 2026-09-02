import { isPlainObject } from "@kizuki/core";
import { PEER_TYPES, TelegramConnectorError, redactedCause } from "./api";
import type { PeerType } from "./api";

export const TELEGRAM_CURSOR_SCHEMA = "kizuki.telegram-cursor/v1" as const;

/** Events per `SyncBatch`; also the per-dialog read limit within one batch. */
export const BATCH_LIMIT = 500;
/** Dialogs listed per run; reaching it degrades health rather than silently truncating. */
export const MAX_DIALOGS = 5000;
/** Most recent messages re-read per dialog to notice edits. */
export const EDIT_WINDOW = 200;

export interface DialogCursor {
  peer_type: PeerType;
  last_id: number;
  exhausted: boolean;
}

export interface SyncPass {
  started_at: number;
  next_peer: string | null;
}

export interface TelegramCursor {
  schema: typeof TELEGRAM_CURSOR_SCHEMA;
  /** Keyed by marked peer id; walked in ascending string order. */
  dialogs: Record<string, DialogCursor>;
  phase: "backfill" | "synced";
  /** Unix seconds; edits newer than this are re-emitted. */
  edit_watermark: number;
  pass: SyncPass | null;
}

const TOP_LEVEL_KEYS = [
  "schema",
  "dialogs",
  "phase",
  "edit_watermark",
  "pass",
] as const;
const DIALOG_KEYS = ["peer_type", "last_id", "exhausted"] as const;
const PASS_KEYS = ["started_at", "next_peer"] as const;
const PHASES = ["backfill", "synced"] as const;

export function parseCursor(cursor: string): TelegramCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw malformed(error);
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactKeys(parsed, TOP_LEVEL_KEYS) ||
    parsed["schema"] !== TELEGRAM_CURSOR_SCHEMA ||
    !isPhase(parsed["phase"]) ||
    !isCount(parsed["edit_watermark"]) ||
    !isPlainObject(parsed["dialogs"])
  ) {
    throw malformed();
  }
  const rawDialogs = parsed["dialogs"];
  const names = Object.keys(rawDialogs);
  if (names.length > MAX_DIALOGS) throw malformed();
  const dialogs: Record<string, DialogCursor> = {};
  for (const name of names) {
    const raw = rawDialogs[name];
    if (
      !/^-?[0-9]{1,20}$/.test(name) ||
      !isPlainObject(raw) ||
      !hasExactKeys(raw, DIALOG_KEYS) ||
      !isPeerType(raw["peer_type"]) ||
      !isCount(raw["last_id"]) ||
      typeof raw["exhausted"] !== "boolean"
    ) {
      throw malformed();
    }
    dialogs[name] = {
      peer_type: raw["peer_type"],
      last_id: raw["last_id"],
      exhausted: raw["exhausted"],
    };
  }
  const rawPass = parsed["pass"];
  let pass: SyncPass | null = null;
  if (rawPass !== null) {
    if (
      !isPlainObject(rawPass) ||
      !hasExactKeys(rawPass, PASS_KEYS) ||
      !isCount(rawPass["started_at"]) ||
      !(rawPass["next_peer"] === null || typeof rawPass["next_peer"] === "string")
    ) {
      throw malformed();
    }
    pass = {
      started_at: rawPass["started_at"],
      next_peer: rawPass["next_peer"],
    };
  }
  return {
    schema: TELEGRAM_CURSOR_SCHEMA,
    dialogs,
    phase: parsed["phase"],
    edit_watermark: parsed["edit_watermark"],
    pass,
  };
}

/**
 * Rebuilds `dialogs` in ascending string order so an unchanged walk always
 * encodes to the same text, whatever order the walk mutated the entries in.
 */
export function encodeCursor(cursor: TelegramCursor): string {
  const dialogs: Record<string, DialogCursor> = {};
  for (const name of Object.keys(cursor.dialogs).sort()) {
    const dialog = cursor.dialogs[name];
    if (dialog === undefined) continue;
    dialogs[name] = dialog;
  }
  const text = JSON.stringify({
    schema: cursor.schema,
    dialogs,
    phase: cursor.phase,
    edit_watermark: cursor.edit_watermark,
    pass: cursor.pass,
  });
  parseCursor(text);
  return text;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPeerType(value: unknown): value is PeerType {
  return typeof value === "string" && PEER_TYPES.includes(value as PeerType);
}

function isPhase(value: unknown): value is "backfill" | "synced" {
  return (
    typeof value === "string" && (PHASES as readonly string[]).includes(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function malformed(cause?: unknown): TelegramConnectorError {
  // A JSON parser quotes the token it stopped on, and a cursor is stored text
  // the connector did not necessarily write; the shape is all that may travel.
  return new TelegramConnectorError(
    "parse_error",
    "kizuki.telegram: malformed cursor",
    cause === undefined ? undefined : { cause: redactedCause(cause) },
  );
}
