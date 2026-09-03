import type { Database } from "bun:sqlite";
import type { LedgerCursor } from "@kizuki/core";
import {
  indexEvent,
  indexPage,
  listCanonPages,
  readReceiptsLog,
  readSince,
} from "@kizuki/core";

export function indexEventsSince(db: Database, since: LedgerCursor): number {
  let cursor: LedgerCursor | null = since;
  let indexed = 0;
  for (;;) {
    const page = readSince(db, cursor, 500);
    if (page.events.length === 0) break;
    for (const event of page.events) {
      indexEvent(db, event);
      indexed += 1;
    }
    if (page.cursor === null || page.events.length < 500) break;
    cursor = page.cursor;
  }
  return indexed;
}

export function indexPagePath(
  db: Database,
  vaultPath: string,
  relPath: string,
): boolean {
  const page = listCanonPages(vaultPath).find(
    (candidate) => candidate.relPath === relPath,
  );
  if (page === undefined) return false;
  indexPage(db, page);
  return true;
}

export function indexPromotedSince(
  db: Database,
  vaultPath: string,
  at: string,
): number {
  const paths = new Set(
    readReceiptsLog(vaultPath)
      .filter((receipt) => receipt.at >= at)
      .map((receipt) => receipt.page_path),
  );
  let indexed = 0;
  for (const relPath of paths) {
    if (indexPagePath(db, vaultPath, relPath)) indexed += 1;
  }
  return indexed;
}
