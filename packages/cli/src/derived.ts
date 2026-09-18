import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { CanonReceipt, CaptureEvent, LedgerCursor, RetrievalPort } from "@kizuki/core";
import {
  count,
  countCanonReceipts,
  countSince,
  isLiveCanonPage,
  isPlainObject,
  listCanonPagesReport,
  listCanonReceipts,
  pendingRetrievalOps,
  readSince,
} from "@kizuki/core";
import { indexEvents, indexPage, publishLedgerEvent, removeCanonPath } from "@kizuki/core/internal";
import { writeAtomicFile } from "./atomic-file";

export const INDEX_CURSOR_SCHEMA = "kizuki.cli.index-cursor/v1" as const;
export const INDEX_CURSOR_PATH = ".kizuki/index-cursor.json";

export interface IndexCursor {
  schema: typeof INDEX_CURSOR_SCHEMA;
  generation: number;
  accepted_at: string | null;
  event_id: string | null;
  receipt_id: string | null;
  events_seen: number;
  receipts_seen: number;
}

export interface IndexReport {
  events: number;
  pages: number;
  cursor: IndexCursor;
  /** Records the next pass would still take in. Zero only when the index is current. */
  remaining: number;
  degraded: string[];
}

/** Records per durable batch: one commit, and persisted progress, per batch. */
export const DERIVED_BATCH_RECORDS = 500;

/**
 * Records one serve pass may index before it records progress and yields. A
 * pass that never finishes never records anything, so a large estate stays
 * behind forever; a bounded pass always leaves the next one less to do.
 */
export const DERIVED_PASS_RECORDS = 50_000;

export interface CatchUpOptions {
  /** Records this call may index. Absent means catch up completely. */
  readonly limit?: number;
  /** Called with the cursor after every durable batch. */
  readonly onBatch?: (cursor: IndexCursor) => void;
}

function cursorPath(vaultPath: string): string {
  return join(vaultPath, INDEX_CURSOR_PATH);
}

export function emptyIndexCursor(): IndexCursor {
  return {
    schema: INDEX_CURSOR_SCHEMA,
    generation: 1,
    accepted_at: null,
    event_id: null,
    receipt_id: null,
    events_seen: 0,
    receipts_seen: 0,
  };
}

export function readIndexCursor(vaultPath: string): IndexCursor {
  const path = cursorPath(vaultPath);
  if (!existsSync(path)) return emptyIndexCursor();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed) || parsed["schema"] !== INDEX_CURSOR_SCHEMA) {
      return emptyIndexCursor();
    }
    const generation =
      typeof parsed["generation"] === "number" &&
      Number.isInteger(parsed["generation"]) &&
      parsed["generation"] > 0
        ? parsed["generation"]
        : 1;
    return {
      schema: INDEX_CURSOR_SCHEMA,
      generation,
      accepted_at:
        typeof parsed["accepted_at"] === "string" ? parsed["accepted_at"] : null,
      event_id: typeof parsed["event_id"] === "string" ? parsed["event_id"] : null,
      receipt_id:
        typeof parsed["receipt_id"] === "string" ? parsed["receipt_id"] : null,
      events_seen:
        typeof parsed["events_seen"] === "number" &&
        Number.isInteger(parsed["events_seen"]) &&
        parsed["events_seen"] >= 0
          ? parsed["events_seen"]
          : 0,
      receipts_seen:
        typeof parsed["receipts_seen"] === "number" &&
        Number.isInteger(parsed["receipts_seen"]) &&
        parsed["receipts_seen"] >= 0
          ? parsed["receipts_seen"]
          : 0,
    };
  } catch {
    return emptyIndexCursor();
  }
}

export function writeIndexCursor(vaultPath: string, cursor: IndexCursor): void {
  writeAtomicFile(cursorPath(vaultPath), `${JSON.stringify(cursor)}\n`);
}

function eventSince(cursor: IndexCursor): LedgerCursor | null {
  if (cursor.accepted_at === null || cursor.event_id === null) return null;
  return { accepted_at: cursor.accepted_at, event_id: cursor.event_id };
}

export function indexEventsFromCursor(
  db: Database,
  cursor: IndexCursor,
  onEvent?: (event: CaptureEvent) => void,
  options: CatchUpOptions = {},
): {
  indexed: number;
  cursor: IndexCursor;
  /** False when the pass stopped on its record budget with events still behind. */
  done: boolean;
} {
  let next = cursor;
  let since = eventSince(cursor);
  let indexed = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (;;) {
    if (indexed >= limit) return { indexed, cursor: next, done: false };
    const size = Math.min(DERIVED_BATCH_RECORDS, limit - indexed);
    const page = readSince(db, since, size);
    if (page.events.length === 0) break;
    // One commit per batch. A commit per event costs one durable write per
    // record, which is why a large estate never finished a catch-up pass.
    indexEvents(db, page.events);
    for (const event of page.events) onEvent?.(event);
    indexed += page.events.length;
    if (page.cursor !== null) {
      next = {
        ...next,
        accepted_at: page.cursor.accepted_at,
        event_id: page.cursor.event_id,
      };
      options.onBatch?.(next);
    }
    if (page.cursor === null || page.events.length < size) break;
    since = page.cursor;
  }
  return { indexed, cursor: next, done: true };
}

function receiptAfter(left: string | null, right: string): boolean {
  return left === null || right > left;
}

/** Page size stays at the core list cap so a walk cannot miss later rows. */
export const RECEIPT_PAGE = 10_000;

export function* walkCanonReceipts(
  db: Database,
  pageSize = RECEIPT_PAGE,
): Generator<CanonReceipt> {
  const size = Math.min(Math.max(pageSize, 1), RECEIPT_PAGE);
  let offset = 0;
  for (;;) {
    const page = listCanonReceipts(db, { limit: size, offset });
    if (page.length === 0) return;
    for (const receipt of page) yield receipt;
    if (page.length < size) return;
    offset += page.length;
  }
}

/** Row count only; freshness runs on every read and must not parse every receipt. */
export function countCanonReceiptRows(db: Database): number {
  return countCanonReceipts(db);
}

function withdrawIndexedCanon(db: Database, pagePath: string, pageId?: string): void {
  removeCanonPath(db, pagePath, pageId);
}

export function indexReceiptsFromCursor(
  db: Database,
  vaultPath: string,
  cursor: IndexCursor,
  scanPages: typeof listCanonPagesReport = listCanonPagesReport,
  options: CatchUpOptions = {},
): { indexed: number; cursor: IndexCursor; done: boolean } {
  let pages: Map<string, ReturnType<typeof listCanonPagesReport>["pages"][number]> | undefined;
  let indexed = 0;
  let lastId = cursor.receipt_id;
  let processed = 0;
  let batched = 0;
  let done = true;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (const receipt of walkCanonReceipts(db)) {
    if (!receiptAfter(cursor.receipt_id, receipt.receipt_id)) continue;
    if (processed >= limit) {
      done = false;
      break;
    }
    if (pages === undefined) {
      const report = scanPages(vaultPath);
      pages = new Map(report.pages.map((page) => [page.relPath, page]));
      const duplicatePaths = new Set(report.skipped
        .filter((entry) => entry.code === "duplicate")
        .map((entry) => entry.relPath));
      for (const path of duplicatePaths) {
        withdrawIndexedCanon(db, path);
      }
    }
    const page = pages.get(receipt.page_path);
    if (page !== undefined && isLiveCanonPage(page) && receipt.page_action !== "archive") {
      indexPage(db, page);
      indexed += 1;
    } else {
      withdrawIndexedCanon(db, receipt.page_path, page?.id);
      for (const candidate of receipt.candidates) {
        withdrawIndexedCanon(db, receipt.page_path, candidate.page_id);
      }
    }
    if (lastId === null || receipt.receipt_id > lastId) lastId = receipt.receipt_id;
    processed += 1;
    if ((batched += 1) >= DERIVED_BATCH_RECORDS) {
      batched = 0;
      options.onBatch?.({ ...cursor, receipt_id: lastId });
    }
  }
  return {
    indexed,
    done,
    // The "index is current" marker only moves when the walk actually ended.
    cursor: {
      ...cursor,
      receipt_id: lastId,
      receipts_seen: done ? countCanonReceipts(db) : cursor.receipts_seen,
    },
  };
}

export function refreshDerived(
  db: Database,
  vaultPath: string,
  onEvent?: (event: CaptureEvent) => void,
  options: { limit?: number } = {},
): IndexReport {
  const start = readIndexCursor(vaultPath);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const onBatch = (batch: IndexCursor): void => writeIndexCursor(vaultPath, batch);
  const events = indexEventsFromCursor(db, start, onEvent, { limit, onBatch });
  const pages = indexReceiptsFromCursor(db, vaultPath, events.cursor, listCanonPagesReport, {
    limit: Math.max(0, limit - events.indexed),
    onBatch,
  });
  const cursor: IndexCursor = {
    ...pages.cursor,
    // Only a walk that reached the end may claim the ledger is fully indexed.
    events_seen: events.done ? count(db) : start.events_seen,
  };
  writeIndexCursor(vaultPath, cursor);
  return {
    events: events.indexed,
    pages: pages.indexed,
    cursor,
    remaining: indexBacklog(db, cursor),
    degraded: [],
  };
}

export function tryRefreshDerived(
  db: Database,
  vaultPath: string,
  options: { limit?: number } = {},
): IndexReport {
  try {
    return refreshDerived(db, vaultPath, undefined, options);
  } catch (error) {
    const cursor = readIndexCursor(vaultPath);
    return {
      events: 0,
      pages: 0,
      cursor,
      remaining: indexBacklog(db, cursor),
      degraded: [
        `derived-index: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/** Floor index plus v1 event publication when a retrieval port is bound. */
export async function refreshAndPublishDerived(
  db: Database,
  vaultPath: string,
  retrieval: RetrievalPort | undefined,
): Promise<IndexReport> {
  if (retrieval === undefined) return tryRefreshDerived(db, vaultPath);
  const pending: CaptureEvent[] = [];
  let report: IndexReport;
  try {
    report = refreshDerived(db, vaultPath, (event) => pending.push(event));
  } catch (error) {
    const cursor = readIndexCursor(vaultPath);
    return {
      events: 0,
      pages: 0,
      cursor,
      remaining: indexBacklog(db, cursor),
      degraded: [`derived-index: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  try {
    for (const event of pending) await publishLedgerEvent(retrieval, event);
    return report;
  } catch (error) {
    return {
      ...report,
      degraded: [
        ...report.degraded,
        `retrieval-publish: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function indexMarkersCurrent(db: Database, cursor: IndexCursor): boolean {
  return count(db) === cursor.events_seen && countCanonReceipts(db) === cursor.receipts_seen;
}

/**
 * Records the next catch-up pass would take in. Zero only when the index is
 * current, so a sweep can report progress instead of an empty pass while it is
 * still behind.
 */
export function indexBacklog(db: Database, vaultPathOrCursor: string | IndexCursor): number {
  const cursor =
    typeof vaultPathOrCursor === "string" ? readIndexCursor(vaultPathOrCursor) : vaultPathOrCursor;
  const behind =
    countSince(db, eventSince(cursor)) + countCanonReceipts(db, cursor.receipt_id);
  if (behind > 0) return behind;
  // Positionally current, but a marker still disagrees (a purge shrank the
  // ledger, say). One more pass re-stamps it.
  return indexMarkersCurrent(db, cursor) ? 0 : 1;
}

export function indexFreshness(
  db: Database,
  vaultPath: string,
): { fresh: boolean; degraded: string[] } {
  const cursor = readIndexCursor(vaultPath);
  const degraded: string[] = [];
  if (count(db) !== cursor.events_seen) {
    degraded.push("index-behind-ledger");
  }
  if (countCanonReceipts(db) !== cursor.receipts_seen) {
    degraded.push("index-behind-receipts");
  }
  if (pendingRetrievalOps(db, 1).length > 0) {
    degraded.push("retrieval-ops-pending");
  }
  return { fresh: degraded.length === 0, degraded };
}
