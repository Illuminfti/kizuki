import type { CaptureEventInput, Cursor, SyncBatch } from "@kizuki/core";
import { decodeCursor, emptyCursor, encodeCursor } from "./cursor";
import type { ImapCursor, ImapFolderCursor } from "./cursor";
import { folderLabel, messageEvent, tombstoneEvent } from "./events";
import { ImapSession } from "./imap/session";
import type { MessageSummary, SessionOptions } from "./imap/session";
import { MAX_COMMAND_BYTES } from "./imap/client";
import { MAX_LINE_BYTES } from "./imap/tokenizer";
import type { ImapState } from "./state";
import type { ImapDialer } from "./transport";
import {
  addUid,
  chunk,
  countUids,
  formatSet,
  parseSet,
  removeUid,
  uids,
} from "./uidset";

export const WINDOW = 1000;
export const BATCH = 200;
export const EXPUNGE_CHUNK = 500;
export const BODY_FETCH = 20;
/**
 * A server that keeps refusing bodies must not grow the cursor without limit,
 * so the hole list stops accepting new UIDs once it reaches a page's worth.
 */
export const MAX_PENDING = 1_000;

/**
 * A body fetch is the one command that legitimately moves megabytes, and the
 * client cuts off a reply that outgrows its budget. The batch therefore
 * shrinks to whatever `max_message_bytes` the owner set, rather than asking
 * for twenty large messages at once and being disconnected for it.
 */
export function bodyFetchSize(maxMessageBytes: number): number {
  const perMessage = Math.max(1, maxMessageBytes) + MAX_LINE_BYTES;
  return Math.max(
    1,
    Math.min(BODY_FETCH, Math.floor(MAX_COMMAND_BYTES / perMessage)),
  );
}

export interface WalkDeps {
  dial: ImapDialer;
  state: ImapState;
  now: () => Date;
  session?: SessionOptions;
}

export interface WalkResult {
  batch: SyncBatch;
  /** Human-readable facts the health report should surface for this run. */
  notes: string[];
}

function group<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

async function fetchBodiesFor(
  session: ImapSession,
  summaries: MessageSummary[],
  maxMessageBytes: number,
): Promise<Map<number, { raw: Uint8Array; section: "" | "HEADER" }>> {
  const bodies = new Map<number, { raw: Uint8Array; section: "" | "HEADER" }>();
  const full = summaries.filter((summary) => summary.size <= maxMessageBytes);
  const headerOnly = summaries.filter(
    (summary) => summary.size > maxMessageBytes,
  );

  for (const batch of group(full, bodyFetchSize(maxMessageBytes))) {
    const fetched = await session.fetchBodies(
      batch.map((summary) => summary.uid),
      "",
    );
    for (const [uid, raw] of fetched) bodies.set(uid, { raw, section: "" });
  }
  for (const batch of group(headerOnly, BODY_FETCH)) {
    const fetched = await session.fetchBodies(
      batch.map((summary) => summary.uid),
      "HEADER",
    );
    for (const [uid, raw] of fetched)
      bodies.set(uid, { raw, section: "HEADER" });
  }
  return bodies;
}

interface FolderPlan {
  wire: string;
  display: string;
  entry: ImapFolderCursor;
}

function initialEntry(uidvalidity: number, uidnext: number): ImapFolderCursor {
  return {
    uidvalidity,
    scan_from: 1,
    uidnext,
    known: "",
    pending: "",
    done: 1 >= uidnext,
  };
}

/**
 * One algorithm behind both entry points. The cursor is never null: a fully
 * walked mailbox has to remember what it already saw, or the next `sync`
 * would forget the walk and re-emit everything as new.
 */
export async function walkMailboxes(
  deps: WalkDeps,
  rawCursor: Cursor | null,
  mode: "backfill" | "sync",
): Promise<WalkResult> {
  const cursor: ImapCursor =
    rawCursor === null ? emptyCursor() : decodeCursor(rawCursor);
  const observedAt = deps.now().toISOString();
  const events: CaptureEventInput[] = [];
  const notes: string[] = [];

  const session = await ImapSession.open(
    deps.dial,
    deps.state,
    deps.session ?? {},
  );
  try {
    for (const wire of deps.state.folders) {
      const display = folderLabel(wire);
      const status = await session.examine(wire);
      const stored = cursor.folders[wire];
      const plan: FolderPlan = {
        wire,
        display,
        entry: stored ?? initialEntry(status.uidvalidity, status.uidnext),
      };

      const folderTombstones: CaptureEventInput[] = [];
      const folderEvents: CaptureEventInput[] = [];

      const renumbered =
        stored !== undefined && stored.uidvalidity !== status.uidvalidity;
      if (renumbered) {
        // The drain runs under the OLD uidvalidity and keeps it in the cursor
        // until every old id is tombstoned, so a large mailbox costs one page
        // per call like every other path.
        drainKnown(plan, observedAt, events.length, folderTombstones, true);
        if (parseSet(plan.entry.known).length > 0) {
          cursor.folders[wire] = plan.entry;
          events.push(...folderTombstones);
          continue;
        }
        plan.entry = initialEntry(status.uidvalidity, status.uidnext);
        notes.push(`uidvalidity changed: ${display}`);
      }

      const wasDone = plan.entry.done && plan.entry.scan_from >= status.uidnext;
      plan.entry.uidnext = status.uidnext;
      plan.entry.done = plan.entry.scan_from >= status.uidnext;

      // A hole from an earlier walk is retried before anything else: the UID
      // is still the only handle on that message.
      await retryPending(
        session,
        plan,
        deps.state.max_message_bytes,
        observedAt,
        events.length + folderTombstones.length,
        folderEvents,
      );

      // `alreadyEmitted` counts everything that is NOT in `into`: the callee
      // adds its own array's length. Counting the target array here too would
      // charge a retried message twice and stop the scan before it started.
      if (mode === "sync" && wasDone && !renumbered) {
        await detectExpunges(
          session,
          plan,
          observedAt,
          events.length + folderEvents.length,
          folderTombstones,
        );
      } else {
        await pageFolder(
          session,
          plan,
          deps.state.max_message_bytes,
          observedAt,
          events.length + folderTombstones.length,
          folderEvents,
        );
      }

      // A body the server did not hand over leaves a hole in the ledger, so
      // the run says so rather than reading as a clean page.
      const holes = countUids(parseSet(plan.entry.pending));
      if (holes > 0) {
        notes.push(`message bodies not returned: ${display} (${holes})`);
      }

      cursor.folders[wire] = plan.entry;
      events.push(...folderTombstones, ...folderEvents);
    }
    await session.logout();
  } catch (error) {
    session.close();
    throw error;
  }

  return { batch: { events, cursor: encodeCursor(cursor) }, notes };
}

/**
 * Re-requests the bodies an earlier walk did not get. A UID the server no
 * longer lists was expunged before it could be read: nothing was emitted for
 * it, so it simply leaves the hole list without a tombstone.
 */
async function retryPending(
  session: ImapSession,
  plan: FolderPlan,
  maxMessageBytes: number,
  observedAt: string,
  alreadyEmitted: number,
  into: CaptureEventInput[],
): Promise<void> {
  const entry = plan.entry;
  // `holes` is the set this pass walks; `pending` is what survives it.
  const holes = parseSet(entry.pending);
  if (holes.length === 0) return;
  let pending = holes;
  for (const piece of chunk(holes, BODY_FETCH)) {
    if (alreadyEmitted + into.length >= BATCH) break;
    const requested = new Set(uids(parseSet(piece)));
    const summaries = (await session.fetchSummaries(piece)).filter((summary) =>
      requested.has(summary.uid),
    );
    const present = new Set(summaries.map((summary) => summary.uid));
    for (const uid of uids(parseSet(piece))) {
      if (!present.has(uid)) pending = removeUid(pending, uid);
    }
    const room = BATCH - (alreadyEmitted + into.length);
    const selected = summaries.slice(0, room);
    const bodies = await fetchBodiesFor(session, selected, maxMessageBytes);
    for (const summary of selected) {
      const body = bodies.get(summary.uid);
      if (body === undefined) continue;
      into.push(
        messageEvent({
          folderWire: plan.wire,
          folderDisplay: plan.display,
          uidvalidity: entry.uidvalidity,
          uid: summary.uid,
          internaldate: summary.internaldate,
          size: summary.size,
          raw: body.raw,
          section: body.section,
          observedAt,
        }),
      );
      entry.known = formatSet(addUid(parseSet(entry.known), summary.uid));
      pending = removeUid(pending, summary.uid);
    }
  }
  entry.pending = formatSet(pending);
}

async function pageFolder(
  session: ImapSession,
  plan: FolderPlan,
  maxMessageBytes: number,
  observedAt: string,
  alreadyEmitted: number,
  into: CaptureEventInput[],
): Promise<void> {
  const entry = plan.entry;
  while (!entry.done && alreadyEmitted + into.length < BATCH) {
    const windowEnd = Math.min(entry.scan_from + WINDOW - 1, entry.uidnext - 1);
    // `n:*` is never used for scanning: a server answers it with the last
    // message when n is past the end, which would re-emit a UID forever.
    // A server that answers a bounded window with UIDs outside it would
    // otherwise push `scan_from` past everything below them, and the rest of
    // the mailbox would be unreachable for the life of this cursor.
    const summaries = (
      await session.fetchSummaries(`${entry.scan_from}:${windowEnd}`)
    ).filter(
      (summary) => summary.uid >= entry.scan_from && summary.uid <= windowEnd,
    );
    const room = BATCH - (alreadyEmitted + into.length);
    const selected = summaries.slice(0, room);
    const truncated = selected.length < summaries.length;
    const bodies = await fetchBodiesFor(session, selected, maxMessageBytes);

    for (const summary of selected) {
      const body = bodies.get(summary.uid);
      if (body === undefined) {
        // The UID stays out of `known` (nothing was emitted for it, so a later
        // sync must not tombstone it) and goes on the retry list instead, or
        // the scan would walk past the only handle the message has.
        if (countUids(parseSet(entry.pending)) < MAX_PENDING) {
          entry.pending = formatSet(addUid(parseSet(entry.pending), summary.uid));
        }
        continue;
      }
      into.push(
        messageEvent({
          folderWire: plan.wire,
          folderDisplay: plan.display,
          uidvalidity: entry.uidvalidity,
          uid: summary.uid,
          internaldate: summary.internaldate,
          size: summary.size,
          raw: body.raw,
          section: body.section,
          observedAt,
        }),
      );
      entry.known = formatSet(addUid(parseSet(entry.known), summary.uid));
    }

    const lastSelected = selected[selected.length - 1];
    entry.scan_from =
      truncated && lastSelected !== undefined
        ? lastSelected.uid + 1
        : windowEnd + 1;
    entry.done = entry.scan_from >= entry.uidnext;
    if (truncated) return;
  }
}

/**
 * Tombstones every id still in `known`, up to the batch cap, and leaves the
 * rest for the next call. Used when the server renumbered the mailbox: every
 * old id is gone by definition, so no existence check is needed.
 */
function drainKnown(
  plan: FolderPlan,
  observedAt: string,
  alreadyEmitted: number,
  into: CaptureEventInput[],
  uidvalidityReset: boolean,
): void {
  const entry = plan.entry;
  let known = parseSet(entry.known);
  for (const uid of uids(known)) {
    if (alreadyEmitted + into.length >= BATCH) break;
    into.push(
      tombstoneEvent({
        folderWire: plan.wire,
        folderDisplay: plan.display,
        uidvalidity: entry.uidvalidity,
        uid,
        observedAt,
        ...(uidvalidityReset ? { uidvalidityReset: true } : {}),
      }),
    );
    known = removeUid(known, uid);
  }
  entry.known = formatSet(known);
}

async function detectExpunges(
  session: ImapSession,
  plan: FolderPlan,
  observedAt: string,
  alreadyEmitted: number,
  into: CaptureEventInput[],
): Promise<void> {
  const entry = plan.entry;
  let known = parseSet(entry.known);
  for (const piece of chunk(known, EXPUNGE_CHUNK)) {
    if (alreadyEmitted + into.length >= BATCH) break;
    const present = new Set(
      (await session.fetchSummaries(piece)).map((summary) => summary.uid),
    );
    for (const uid of uids(parseSet(piece))) {
      if (present.has(uid)) continue;
      // The walk is already done, so the ids left behind simply wait for the
      // next sync; nothing else in the cursor has to change.
      if (alreadyEmitted + into.length >= BATCH) break;
      into.push(
        tombstoneEvent({
          folderWire: plan.wire,
          folderDisplay: plan.display,
          uidvalidity: entry.uidvalidity,
          uid,
          observedAt,
        }),
      );
      known = removeUid(known, uid);
    }
  }
  entry.known = formatSet(known);
}
