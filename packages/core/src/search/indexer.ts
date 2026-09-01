import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { replay } from "../ledger/ledger";
import { listCanonPages } from "../vault/pages";
import type { CanonPage } from "../vault/pages";
import { initSearch } from "./schema";

type SearchDocBindings = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export interface SearchRebuildResult {
  pages: number;
  events: number;
  rebuilt_at: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function insertDoc(db: Database, bindings: SearchDocBindings): void {
  db.query<never, SearchDocBindings>(
    `INSERT INTO search_docs (
       doc_id, scope, title, body, path, page_type, sensitivity,
       occurred_at, connector_id, subjects
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...bindings);
}

function replacePage(db: Database, page: CanonPage): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    page.id,
  );
  insertDoc(db, [
    page.id,
    "canon",
    text(page.data["title"]),
    page.body,
    page.relPath,
    text(page.data["type"]),
    text(page.data["sensitivity"]) || "unlabeled",
    "",
    "",
    JSON.stringify(stringArray(page.data["subjects"])),
  ]);
}

function replaceEvent(db: Database, event: CaptureEvent): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    event.event_id,
  );
  if (event.deleted) return;
  insertDoc(db, [
    event.event_id,
    "ledger",
    `${event.connector_id} ${event.kind}`,
    event.text,
    "",
    event.kind,
    event.sensitivity_hint ?? "unlabeled",
    event.occurred_at,
    event.connector_id,
    JSON.stringify(event.subjects.map(({ subject_id }) => subject_id)),
  ]);
}

export function indexPage(db: Database, page: CanonPage): void {
  db.transaction(() => replacePage(db, page)).immediate();
}

export function indexEvent(db: Database, event: CaptureEvent): void {
  db.transaction(() => replaceEvent(db, event)).immediate();
}

export function removeDoc(db: Database, docId: string): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    docId,
  );
}

export function rebuildSearch(
  db: Database,
  vaultPath: string,
): SearchRebuildResult {
  initSearch(db);
  const pages = listCanonPages(vaultPath);
  const events = [...replay(db, {})].filter(({ deleted }) => !deleted);
  const rebuiltAt = new Date().toISOString();

  db.transaction(() => {
    db.exec("DELETE FROM search_docs");
    for (const page of pages) replacePage(db, page);
    for (const event of events) replaceEvent(db, event);
    const docCount =
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM search_docs",
        )
        .get()?.count ?? 0;
    db.query<never, [string, string, number]>(
      `INSERT INTO derived_meta (layer, rebuilt_at, doc_count)
       VALUES (?, ?, ?)
       ON CONFLICT (layer) DO UPDATE SET
         rebuilt_at = excluded.rebuilt_at,
         doc_count = excluded.doc_count`,
    ).run("search", rebuiltAt, docCount);
  }).immediate();

  return { pages: pages.length, events: events.length, rebuilt_at: rebuiltAt };
}
