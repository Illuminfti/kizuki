import type { CaptureEventInput, Cursor, SyncBatch } from "@kizuki/core";
import { decodeCursor, emptyCursor, encodeCursor } from "./cursor";
import type { ImapCursor, ImapFolderCursor } from "./cursor";
import { messageEvent, tombstoneEvent } from "./events";
import { ImapSession } from "./imap/session";
import type { MessageSummary, SessionOptions } from "./imap/session";
import { decodeModifiedUtf7 } from "./imap/utf7";
import type { ImapState } from "./state";
import type { ImapDialer } from "./transport";
import { addUid, chunk, formatSet, parseSet, removeUid, uids } from "./uidset";

export const WINDOW = 1000;
export const BATCH = 200;
export const EXPUNGE_CHUNK = 500;
export const BODY_FETCH = 20;

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

  for (const batch of group(full, BODY_FETCH)) {
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
      const display = decodeModifiedUtf7(wire);
      const status = await session.examine(wire);
      const stored = cursor.folders[wire];
      const plan: FolderPlan = {
        wire,
        display,
        entry: stored ?? initialEntry(status.uidvalidity, status.uidnext),
      };

      const folderTombstones: CaptureEventInput[] = [];
      const folderEvents: CaptureEventInput[] = [];

      if (stored !== undefined && stored.uidvalidity !== status.uidvalidity) {
        for (const uid of uids(parseSet(stored.known))) {
          folderTombstones.push(
            tombstoneEvent({
              folderWire: wire,
              folderDisplay: display,
              uidvalidity: stored.uidvalidity,
              uid,
              observedAt,
              uidvalidityReset: true,
            }),
          );
        }
        plan.entry = initialEntry(status.uidvalidity, status.uidnext);
        notes.push(`uidvalidity changed: ${display}`);
      }

      const wasDone = plan.entry.done && plan.entry.scan_from >= status.uidnext;
      plan.entry.uidnext = status.uidnext;
      plan.entry.done = plan.entry.scan_from >= status.uidnext;

      if (mode === "sync" && wasDone) {
        await detectExpunges(session, plan, observedAt, folderTombstones);
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
    const summaries = await session.fetchSummaries(
      `${entry.scan_from}:${windowEnd}`,
    );
    const room = BATCH - (alreadyEmitted + into.length);
    const selected = summaries.slice(0, room);
    const truncated = selected.length < summaries.length;
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

async function detectExpunges(
  session: ImapSession,
  plan: FolderPlan,
  observedAt: string,
  into: CaptureEventInput[],
): Promise<void> {
  const entry = plan.entry;
  let known = parseSet(entry.known);
  for (const piece of chunk(known, EXPUNGE_CHUNK)) {
    const present = new Set(
      (await session.fetchSummaries(piece)).map((summary) => summary.uid),
    );
    for (const uid of uids(parseSet(piece))) {
      if (present.has(uid)) continue;
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
