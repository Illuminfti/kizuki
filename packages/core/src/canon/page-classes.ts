import type { Database } from "bun:sqlite";
import type { EventClass } from "../agents/types";
import { credentialShaped } from "../ledger/event-classes";
import { tableExists } from "../ledger/schema";
import type { CanonPage } from "../vault/pages";

type PageContent = Pick<CanonPage, "id" | "contentHash" | "body" | "data">;

/** Disposable content stamp, outside event revisions, receipts and Markdown. */
export function initPageClasses(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS canon_page_classes (
    page_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    credential INTEGER NOT NULL CHECK (credential IN (0, 1))
  ) STRICT, WITHOUT ROWID`);
}

/** Called in receipt completion, including recovery and undo, on the exact after image. */
export function stampPageClasses(db: Database, page: PageContent): void {
  initPageClasses(db);
  db.query(`INSERT INTO canon_page_classes (page_id, content_hash, credential) VALUES (?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET content_hash=excluded.content_hash, credential=excluded.credential`)
    .run(page.id, page.contentHash, credentialShaped(page.body, page.data) ? 1 : 0);
}

export function removePageClasses(db: Database, pageId: string): void {
  if (tableExists(db, "canon_page_classes")) db.query("DELETE FROM canon_page_classes WHERE page_id=?").run(pageId);
}

/** Old vaults, missing caches and changed bytes are scanned rather than assumed clean. */
export function classesOfPage(db: Database, page: PageContent): EventClass[] {
  const stamp = tableExists(db, "canon_page_classes")
    ? db.query<{ credential: number }, [string, string]>(
      "SELECT credential FROM canon_page_classes WHERE page_id=? AND content_hash=?",
    ).get(page.id, page.contentHash)
    : null;
  const credential = stamp === null ? credentialShaped(page.body, page.data) : stamp.credential === 1;
  return credential ? ["credential"] : [];
}
