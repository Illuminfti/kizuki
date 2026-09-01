import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { replay } from "../ledger/ledger";
import { listCanonPages } from "../vault/pages";
import type { CanonPage } from "../vault/pages";
import { initSearch } from "./schema";

interface SearchDocument {
  docId: string;
  scope: "canon" | "ledger";
  title: string;
  body: string;
  path: string;
  pageType: string;
  sensitivity: string;
  occurredAt: string;
  connectorId: string;
  subjects: string[];
}

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

function pageSensitivity(value: unknown): string {
  return value === "public" || value === "personal" || value === "private"
    ? value
    : "unlabeled";
}

function insertDoc(db: Database, doc: SearchDocument): void {
  db.query<
    never,
    [string, string, string, string, string, string, string, string, string, string]
  >(
    `INSERT INTO search_docs (
       doc_id, scope, title, body, path, page_type, sensitivity,
       occurred_at, connector_id, subjects
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    doc.docId,
    doc.scope,
    doc.title,
    doc.body,
    doc.path,
    doc.pageType,
    doc.sensitivity,
    doc.occurredAt,
    doc.connectorId,
    JSON.stringify(doc.subjects),
  );
}

function replacePage(db: Database, page: CanonPage): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    page.id,
  );
  insertDoc(db, {
    docId: page.id,
    scope: "canon",
    title: text(page.data["title"]),
    body: page.body,
    path: page.relPath,
    pageType: text(page.data["type"]),
    sensitivity: pageSensitivity(page.data["sensitivity"]),
    occurredAt: "",
    connectorId: "",
    subjects: stringArray(page.data["subjects"]),
  });
}

function replaceEvent(db: Database, event: CaptureEvent): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    event.event_id,
  );
  if (event.deleted) {
    db.query<never, [string, string]>(
      `DELETE FROM search_docs
       WHERE doc_id IN (
         SELECT event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
       )`,
    ).run(event.connector_id, event.source_record_id);
    return;
  }
  insertDoc(db, {
    docId: event.event_id,
    scope: "ledger",
    title: `${event.connector_id} ${event.kind}`,
    body: event.text,
    path: "",
    pageType: event.kind,
    sensitivity: event.sensitivity_hint ?? "unlabeled",
    occurredAt: event.occurred_at,
    connectorId: event.connector_id,
    subjects: event.subjects.map(({ subject_id }) => subject_id),
  });
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
  const events = [...replay(db, {})];
  const rebuiltAt = new Date().toISOString();
  let pageCount = 0;
  let eventCount = 0;

  db.transaction(() => {
    db.exec("DELETE FROM search_docs");
    for (const page of pages) replacePage(db, page);
    for (const event of events) replaceEvent(db, event);
    const counts = db
      .query<{ scope: string; count: number }, []>(
        "SELECT scope, count(*) AS count FROM search_docs GROUP BY scope",
      )
      .all();
    pageCount = counts.find(({ scope }) => scope === "canon")?.count ?? 0;
    eventCount = counts.find(({ scope }) => scope === "ledger")?.count ?? 0;
    const docCount = pageCount + eventCount;
    db.query<never, [string, string, number]>(
      `INSERT INTO derived_meta (layer, rebuilt_at, doc_count)
       VALUES (?, ?, ?)
       ON CONFLICT (layer) DO UPDATE SET
         rebuilt_at = excluded.rebuilt_at,
         doc_count = excluded.doc_count`,
    ).run("search", rebuiltAt, docCount);
  }).immediate();

  return { pages: pageCount, events: eventCount, rebuilt_at: rebuiltAt };
}
