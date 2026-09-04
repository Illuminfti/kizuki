import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { LedgerCursor } from "@kizuki/core";
import {
  count,
  indexEvent,
  indexPage,
  isPlainObject,
  listCanonPages,
  listCanonReceipts,
  pendingRetrievalOps,
  readSince,
} from "@kizuki/core";
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
  degraded: string[];
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

export function indexEventsFromCursor(db: Database, cursor: IndexCursor): {
  indexed: number;
  cursor: IndexCursor;
} {
  let next = cursor;
  let since = eventSince(cursor);
  let indexed = 0;
  for (;;) {
    const page = readSince(db, since, 500);
    if (page.events.length === 0) break;
    for (const event of page.events) {
      indexEvent(db, event);
      indexed += 1;
    }
    if (page.cursor !== null) {
      next = {
        ...next,
        accepted_at: page.cursor.accepted_at,
        event_id: page.cursor.event_id,
      };
    }
    if (page.cursor === null || page.events.length < 500) break;
    since = page.cursor;
  }
  return { indexed, cursor: next };
}

function receiptAfter(left: string | null, right: string): boolean {
  return left === null || right > left;
}

export function indexReceiptsFromCursor(
  db: Database,
  vaultPath: string,
  cursor: IndexCursor,
): { indexed: number; cursor: IndexCursor } {
  const pages = new Map(listCanonPages(vaultPath).map((page) => [page.relPath, page]));
  const receipts = listCanonReceipts(db, { limit: 10_000 });
  let indexed = 0;
  let lastId = cursor.receipt_id;
  for (const receipt of receipts) {
    if (!receiptAfter(cursor.receipt_id, receipt.receipt_id)) continue;
    const page = pages.get(receipt.page_path);
    if (page !== undefined) {
      indexPage(db, page);
      indexed += 1;
    }
    if (lastId === null || receipt.receipt_id > lastId) lastId = receipt.receipt_id;
  }
  return { indexed, cursor: { ...cursor, receipt_id: lastId } };
}

export function refreshDerived(db: Database, vaultPath: string): IndexReport {
  const start = readIndexCursor(vaultPath);
  const events = indexEventsFromCursor(db, start);
  const pages = indexReceiptsFromCursor(db, vaultPath, events.cursor);
  const receipts = listCanonReceipts(db, { limit: 10_000 });
  const cursor: IndexCursor = {
    ...pages.cursor,
    events_seen: count(db),
    receipts_seen: receipts.length,
  };
  writeIndexCursor(vaultPath, cursor);
  return {
    events: events.indexed,
    pages: pages.indexed,
    cursor,
    degraded: [],
  };
}

export function tryRefreshDerived(db: Database, vaultPath: string): IndexReport {
  try {
    return refreshDerived(db, vaultPath);
  } catch (error) {
    return {
      events: 0,
      pages: 0,
      cursor: readIndexCursor(vaultPath),
      degraded: [
        `derived-index: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
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
  if (pendingRetrievalOps(db, 1).length > 0) {
    degraded.push("retrieval-ops-pending");
  }
  return { fresh: degraded.length === 0, degraded };
}
