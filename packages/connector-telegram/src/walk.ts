import type { CaptureEventInput, SyncBatch } from "@kizuki/core";
import type { TelegramApi, TelegramDialog, TelegramUser } from "./api";
import {
  BATCH_LIMIT,
  EDIT_WINDOW,
  MAX_DIALOGS,
  TELEGRAM_CURSOR_SCHEMA,
  encodeCursor,
  parseCursor,
} from "./cursor";
import type { DialogCursor, TelegramCursor } from "./cursor";
import { mapMessage } from "./map";
import type { PurgeIndex } from "./plan";
import { waitSeconds } from "./sign-in";

export type WalkMode = "backfill" | "sync";

export interface WalkDeps {
  api: TelegramApi;
  self: TelegramUser;
  now: () => number;
  plan: PurgeIndex;
}

/** What one dialog listing showed; absent when the pass needed no listing. */
export interface DialogListing {
  limitReached: boolean;
  /** Peers the cursor still has history for that the account no longer lists. */
  unreadable: string[];
}

export interface WalkResult {
  batch: SyncBatch;
  /** Milliseconds until the provider will accept requests again, or null. */
  floodUntil: number | null;
  /** `null` leaves the caller's view of the account's dialogs as it was. */
  listing: DialogListing | null;
}

interface Batch {
  events: CaptureEventInput[];
  observedAt: string;
  watermark: number;
  mode: WalkMode;
}

export async function listDialogs(
  api: TelegramApi,
): Promise<{ dialogs: TelegramDialog[]; limitReached: boolean }> {
  const dialogs: TelegramDialog[] = [];
  for await (const dialog of api.dialogs(MAX_DIALOGS)) {
    dialogs.push(dialog);
    if (dialogs.length >= MAX_DIALOGS) break;
  }
  return { dialogs, limitReached: dialogs.length >= MAX_DIALOGS };
}

export function seedCursor(dialogs: TelegramDialog[]): TelegramCursor {
  const entries: Record<string, DialogCursor> = {};
  for (const dialog of dialogs) {
    entries[dialog.peer_id] = {
      peer_type: dialog.peer_type,
      last_id: 0,
      exhausted: dialog.top_message_id === 0,
    };
  }
  return {
    schema: TELEGRAM_CURSOR_SCHEMA,
    dialogs: entries,
    phase: "backfill",
    edit_watermark: 0,
    pass: null,
  };
}

/**
 * One bounded pass over the account's dialogs. The returned cursor describes
 * exactly the events in the returned batch, never more: a checkpoint that ran
 * ahead of the ledger would silently lose messages after an interruption.
 */
export async function walk(
  cursorText: string | null,
  mode: WalkMode,
  deps: WalkDeps,
): Promise<WalkResult> {
  const stored = cursorText === null ? null : parseCursor(cursorText);
  if (mode === "backfill" && stored !== null && stored.phase === "synced") {
    // Nothing is left to read, so nothing is worth asking for: a listing here
    // would only spend a request, and one more chance to be told to wait.
    return {
      batch: { events: [], cursor: encodeCursor(stored) },
      floodUntil: null,
      listing: null,
    };
  }
  const listing = await listDialogs(deps.api);
  const cursor = stored ?? seedCursor(listing.dialogs);
  const byPeer = new Map(
    listing.dialogs.map((dialog) => [dialog.peer_id, dialog] as const),
  );
  if (mode === "sync" && cursor.pass === null) {
    for (const dialog of listing.dialogs) {
      cursor.dialogs[dialog.peer_id] ??= {
        peer_type: dialog.peer_type,
        last_id: 0,
        exhausted: false,
      };
    }
    boundDialogs(cursor, byPeer);
    cursor.pass = {
      started_at: Math.floor(deps.now() / 1000),
      next_peer: null,
    };
  }

  const batch: Batch = {
    events: [],
    observedAt: new Date(deps.now()).toISOString(),
    watermark: cursor.edit_watermark,
    mode,
  };
  // What this pass would have read had the account still listed it: a finished
  // dialog is only a loss once sync is watching it for new messages.
  const unreadable = Object.keys(cursor.dialogs)
    .filter(
      (peer) =>
        !byPeer.has(peer) &&
        (mode === "sync" || cursor.dialogs[peer]?.exhausted !== true),
    )
    .sort();
  const keys = Object.keys(cursor.dialogs).sort();
  const resume = mode === "sync" ? cursor.pass?.next_peer ?? null : null;
  let index = resume === null ? 0 : Math.max(0, keys.indexOf(resume));
  let stoppedAt: string | null = null;
  let floodUntil: number | null = null;

  for (; index < keys.length; index += 1) {
    const peer = keys[index];
    const dialogCursor = peer === undefined ? undefined : cursor.dialogs[peer];
    if (peer === undefined || dialogCursor === undefined) continue;
    if (mode === "backfill" && dialogCursor.exhausted) continue;
    const dialog = byPeer.get(peer);
    // Absent from this listing is not the same as read to the end. Leaving the
    // entry alone keeps the backfill honestly unfinished, and health names it.
    if (dialog === undefined) continue;
    let outcome: DialogOutcome;
    try {
      outcome = await readDialog(deps, dialog, dialogCursor, batch);
    } catch (error) {
      const seconds = waitSeconds(error);
      if (seconds === null) throw error;
      floodUntil = deps.now() + seconds * 1000;
      stoppedAt = peer;
      break;
    }
    // Only a dialog whose new messages and whose edit window both ran to the
    // end is behind us; anything else has to be resumed where it stopped.
    if (outcome === "partial") {
      stoppedAt = peer;
      break;
    }
    stoppedAt = keys[index + 1] ?? null;
  }

  if (mode === "sync" && cursor.pass !== null) {
    if (stoppedAt === null) {
      cursor.edit_watermark = cursor.pass.started_at;
      cursor.pass = null;
    } else {
      cursor.pass = { ...cursor.pass, next_peer: stoppedAt };
    }
  }
  if (
    mode === "backfill" &&
    Object.values(cursor.dialogs).every((entry) => entry.exhausted)
  ) {
    cursor.phase = "synced";
    cursor.edit_watermark = Math.floor(deps.now() / 1000);
  }
  return {
    batch: { events: batch.events, cursor: encodeCursor(cursor) },
    floodUntil,
    listing: { limitReached: listing.limitReached, unreadable },
  };
}

/**
 * A cursor may never carry more dialogs than one listing can return. It is
 * validated on the way out, so an entry over the bound would end every later
 * batch in a parse error instead of a checkpoint, with no way back. Only peers
 * the account has stopped listing are dropped, finished ones first: they are
 * the entries this connector can no longer read anything from.
 */
function boundDialogs(
  cursor: TelegramCursor,
  listed: ReadonlyMap<string, TelegramDialog>,
): void {
  let overflow = Object.keys(cursor.dialogs).length - MAX_DIALOGS;
  if (overflow <= 0) return;
  const rank = (peer: string): number =>
    cursor.dialogs[peer]?.exhausted === true ? 0 : 1;
  const evictable = Object.keys(cursor.dialogs)
    .filter((peer) => !listed.has(peer))
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  for (const peer of evictable) {
    if (overflow <= 0) return;
    delete cursor.dialogs[peer];
    overflow -= 1;
  }
}

/** `partial` means the batch filled before this dialog was done with. */
type DialogOutcome = "complete" | "partial";

async function readDialog(
  deps: WalkDeps,
  dialog: TelegramDialog,
  dialogCursor: DialogCursor,
  batch: Batch,
): Promise<DialogOutcome> {
  const known = dialogCursor.last_id;
  const want = BATCH_LIMIT - batch.events.length;
  let seen = 0;
  for await (const message of deps.api.messages(dialog.peer_id, {
    min_id: known,
    limit: want,
  })) {
    seen += 1;
    collect(deps, message, dialog, batch);
    dialogCursor.last_id = Math.max(dialogCursor.last_id, message.id);
    if (batch.events.length >= BATCH_LIMIT) return "partial";
  }
  if (seen < want) dialogCursor.exhausted = true;
  if (batch.mode !== "sync" || known === 0) return "complete";

  // Edits carry no separate feed: re-read the tail of what we already have and
  // re-emit only what changed since the last completed pass. The whole window
  // is read whatever room is left, because a window cut short to fit the batch
  // would be declared clean and never looked at again.
  for await (const message of deps.api.messages(dialog.peer_id, {
    min_id: Math.max(0, known - EDIT_WINDOW),
    max_id: known + 1,
    limit: EDIT_WINDOW,
  })) {
    if (message.edit_date === undefined) continue;
    if (message.edit_date <= batch.watermark) continue;
    collect(deps, message, dialog, batch);
    if (batch.events.length >= BATCH_LIMIT) return "partial";
  }
  return "complete";
}

function collect(
  deps: WalkDeps,
  message: Parameters<typeof mapMessage>[0],
  dialog: TelegramDialog,
  batch: Batch,
): void {
  const event = mapMessage(message, dialog, deps.self, batch.observedAt);
  if (event === null) return;
  batch.events.push(event);
  deps.plan.record(event);
}
