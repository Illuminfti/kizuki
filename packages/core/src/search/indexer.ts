import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { stampDerived } from "../derived-meta";
import { replay } from "../ledger/ledger";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { initSearch } from "./schema";

export type DocScope = "canon" | "ledger";

interface SearchDocument {
  docId: string;
  scope: DocScope;
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
  skipped: SkippedPage[];
  rebuilt_at: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function deleteDoc(db: Database, scope: DocScope, docId: string): void {
  db.query<never, [string, string]>(
    "DELETE FROM search_docs WHERE scope = ? AND doc_id = ?",
  ).run(scope, docId);
}

function pageDocument(page: CanonPage): SearchDocument {
  return {
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
  };
}

function eventDocument(event: CaptureEvent): SearchDocument {
  return {
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
  };
}

/**
 * Injective. Both fields accept any non-empty string, so joining them with a
 * separator either may contain would let two distinct records share a key and
 * one record's tombstone suppress another record's live event on rebuild.
 */
function recordKey(event: CaptureEvent): string {
  return JSON.stringify([event.connector_id, event.source_record_id]);
}

function replacePage(db: Database, page: CanonPage): void {
  deleteDoc(db, "canon", page.id);
  insertDoc(db, pageDocument(page));
}

function replaceEvent(db: Database, event: CaptureEvent): void {
  deleteDoc(db, "ledger", event.event_id);
  if (event.deleted) {
    db.query<never, [string, string]>(
      `DELETE FROM search_docs
       WHERE scope = 'ledger' AND doc_id IN (
         SELECT event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
       )`,
    ).run(event.connector_id, event.source_record_id);
    return;
  }
  insertDoc(db, eventDocument(event));
}

export function indexPage(db: Database, page: CanonPage): void {
  db.transaction(() => replacePage(db, page)).immediate();
}

export function indexEvent(db: Database, event: CaptureEvent): void {
  db.transaction(() => replaceEvent(db, event)).immediate();
}

export function removeDoc(db: Database, scope: DocScope, docId: string): void {
  deleteDoc(db, scope, docId);
}

export function rebuildSearch(
  db: Database,
  vaultPath: string,
): SearchRebuildResult {
  initSearch(db);
  const { pages, skipped } = listCanonPagesReport(vaultPath);
  const events = [...replay(db, {})];
  const rebuiltAt = new Date().toISOString();
  let pageCount = 0;
  let eventCount = 0;

  db.transaction(() => {
    db.exec("DELETE FROM search_docs");
    for (const page of pages) insertDoc(db, pageDocument(page));

    const latestTombstone = new Map<string, number>();
    for (const [index, event] of events.entries()) {
      if (event.deleted) latestTombstone.set(recordKey(event), index);
    }
    for (const [index, event] of events.entries()) {
      if (event.deleted) continue;
      if (index > (latestTombstone.get(recordKey(event)) ?? -1)) {
        insertDoc(db, eventDocument(event));
      }
    }

    const counts = db
      .query<{ scope: string; count: number }, []>(
        "SELECT scope, count(*) AS count FROM search_docs GROUP BY scope",
      )
      .all();
    pageCount = counts.find(({ scope }) => scope === "canon")?.count ?? 0;
    eventCount = counts.find(({ scope }) => scope === "ledger")?.count ?? 0;
    stampDerived(db, "search", rebuiltAt, pageCount + eventCount);
  }).immediate();

  return {
    pages: pageCount,
    events: eventCount,
    skipped,
    rebuilt_at: rebuiltAt,
  };
}
