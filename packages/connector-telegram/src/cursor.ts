import { isPlainObject, sha256Hex } from "@kizuki/core";
import { PEER_TYPES, TelegramConnectorError, redactedCause } from "./api";
import type { PeerType } from "./api";

export const TELEGRAM_CURSOR_SCHEMA = "kizuki.telegram-cursor/v2" as const;
/**
 * The first cursor carried every dialog itself, which stops fitting the host's
 * cursor bound at about 125 dialogs. It is still read, once, so a checkpoint
 * minted before the host store moves its dialogs there instead of restarting.
 */
const LEGACY_CURSOR_SCHEMA = "kizuki.telegram-cursor/v1" as const;

/** Events per `SyncBatch`; also the per-dialog read limit within one batch. */
export const BATCH_LIMIT = 500;
/** Dialogs listed per run; reaching it degrades health rather than silently truncating. */
export const MAX_DIALOGS = 5000;
/** Most recent messages re-read per dialog to notice edits. */
export const EDIT_WINDOW = 200;
/**
 * Wall-clock budget for one batch. The walk stops at a dialog boundary once it
 * is spent, well inside the host's per-call deadline, and the next batch
 * resumes there.
 */
export const WALK_BUDGET_MS = 40_000;

export interface DialogCursor {
  peer_type: PeerType;
  last_id: number;
  exhausted: boolean;
}

export interface SyncPass {
  started_at: number;
  next_peer: string | null;
}

/**
 * The wire cursor. The per-dialog map lives in the host's cursor store; the
 * digest names its contents, so the cursor changes whenever the map does and
 * a caller draining until the cursor settles sees the progress.
 */
export interface TelegramCursor {
  schema: typeof TELEGRAM_CURSOR_SCHEMA;
  phase: "backfill" | "synced";
  /** Unix seconds; edits newer than this are re-emitted. */
  edit_watermark: number;
  pass: SyncPass | null;
  map_digest: string;
  /** Set only when parsed from a v1 cursor; never encoded. */
  legacy_dialogs: Record<string, DialogCursor> | null;
}

const TOP_LEVEL_KEYS = [
  "schema",
  "phase",
  "edit_watermark",
  "pass",
  "map_digest",
] as const;
const LEGACY_TOP_LEVEL_KEYS = [
  "schema",
  "dialogs",
  "phase",
  "edit_watermark",
  "pass",
] as const;
const DIALOG_KEYS = ["peer_type", "last_id", "exhausted"] as const;
const PASS_KEYS = ["started_at", "next_peer"] as const;
const PHASES = ["backfill", "synced"] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const PEER = /^-?[0-9]{1,20}$/;
const DIALOG_ENTRY = /^([a-z]+):([0-9]{1,15}):([01])$/;

/** One dialog as the host store holds it: `user:1234:0`. */
export function encodeDialog(dialog: DialogCursor): string {
  return `${dialog.peer_type}:${dialog.last_id}:${dialog.exhausted ? 1 : 0}`;
}

function decodeDialog(value: string): DialogCursor {
  const match = DIALOG_ENTRY.exec(value);
  const peerType = match?.[1];
  const lastId = Number(match?.[2]);
  if (match === null || !isPeerType(peerType) || !isCount(lastId)) throw malformed();
  return { peer_type: peerType, last_id: lastId, exhausted: match[3] === "1" };
}

/** The per-dialog map read back from the host store; anything unreadable fails closed. */
export function decodeDialogs(store: ReadonlyMap<string, string>): Record<string, DialogCursor> {
  if (store.size > MAX_DIALOGS) throw malformed();
  const dialogs: Record<string, DialogCursor> = {};
  for (const [peer, value] of store) {
    if (!PEER.test(peer)) throw malformed();
    dialogs[peer] = decodeDialog(value);
  }
  return dialogs;
}

/** Names the map's contents, whatever order the walk touched the entries in. */
export function digestDialogs(dialogs: Record<string, DialogCursor>): string {
  const lines = Object.keys(dialogs)
    .sort()
    .map((peer) => `${peer}=${encodeDialog(dialogs[peer] as DialogCursor)}`);
  return sha256Hex(lines.join("\n"));
}

export function parseCursor(cursor: string): TelegramCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw malformed(error);
  }
  if (!isPlainObject(parsed)) throw malformed();
  const legacy = parsed["schema"] === LEGACY_CURSOR_SCHEMA;
  if (
    !hasExactKeys(parsed, legacy ? LEGACY_TOP_LEVEL_KEYS : TOP_LEVEL_KEYS) ||
    (!legacy && parsed["schema"] !== TELEGRAM_CURSOR_SCHEMA) ||
    !isPhase(parsed["phase"]) ||
    !isCount(parsed["edit_watermark"])
  ) {
    throw malformed();
  }
  const digest = legacy ? "" : parsed["map_digest"];
  if (!legacy && (typeof digest !== "string" || !DIGEST.test(digest))) throw malformed();
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
    phase: parsed["phase"],
    edit_watermark: parsed["edit_watermark"],
    pass,
    map_digest: digest as string,
    legacy_dialogs: legacy ? parseLegacyDialogs(parsed["dialogs"]) : null,
  };
}

function parseLegacyDialogs(value: unknown): Record<string, DialogCursor> {
  if (!isPlainObject(value)) throw malformed();
  const names = Object.keys(value);
  if (names.length > MAX_DIALOGS) throw malformed();
  const dialogs: Record<string, DialogCursor> = {};
  for (const name of names) {
    const raw = value[name];
    if (
      !PEER.test(name) ||
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
  return dialogs;
}

/** Always the current schema; a legacy cursor's dialogs move to the store, not the wire. */
export function encodeCursor(cursor: TelegramCursor): string {
  const text = JSON.stringify({
    schema: cursor.schema,
    phase: cursor.phase,
    edit_watermark: cursor.edit_watermark,
    pass: cursor.pass,
    map_digest: cursor.map_digest,
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
