import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { stampDerived } from "../derived-meta";
import type { DerivedStamp } from "../derived-meta";
import { latestLedgerCursor, replayLive } from "../ledger/ledger";
import { retrievalDocId } from "../retrieval/ids";
import { ulid } from "../util/ulid";
import {
  canonPagesHash,
  isLiveCanonPage,
  listCanonPagesReport,
  stringArray,
} from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { initSearch } from "./schema";

export type DocScope = "canon" | "ledger";

export interface SearchDocument {
  docId: string;
  scope: DocScope;
  title: string;
  body: string;
  path: string;
  pageType: string;
  sensitivity: string;
  taint: "clean" | "quoted";
  authority: RetrievalAuthority;
  occurredAt: string;
  connectorId: string;
  subjects: string[];
  provenance: string[];
}

export interface SearchRebuildInput {
  generation: string;
  pages: readonly CanonPage[];
  skipped: readonly SkippedPage[];
  rebuilt_at: string;
  canon_hash: string | null;
}

export interface SearchRebuildResult {
  pages: number;
  events: number;
  skipped: SkippedPage[];
  rebuilt_at: string;
  generation: string;
  status: "ok" | "degraded";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pageSensitivity(value: unknown): string {
  return value === "public" || value === "personal" || value === "private"
    ? value
    : "unlabeled";
}

function pageTaint(value: unknown): "clean" | "quoted" {
  return value === "quoted" ? "quoted" : "clean";
}

function namespaced(scope: DocScope, rawId: string): string {
  return retrievalDocId(scope === "canon" ? "page" : "event", rawId);
}

export function pageDocument(page: CanonPage): SearchDocument {
  return {
    docId: retrievalDocId("page", page.id),
    scope: "canon",
    title: text(page.data["title"]),
    body: page.body,
    path: page.relPath,
    pageType: text(page.data["type"]),
    sensitivity: pageSensitivity(page.data["sensitivity"]),
    taint: pageTaint(page.data["taint"]),
    authority: "owner_authored",
    occurredAt: "",
    connectorId: "",
    subjects: stringArray(page.data["subjects"]),
    provenance: stringArray(page.data["sources"]),
  };
}

export function eventDocument(event: CaptureEvent): SearchDocument {
  const eventId = retrievalDocId("event", event.event_id);
  return {
    docId: eventId,
    scope: "ledger",
    title: `${event.connector_id} ${event.kind}`,
    body: event.text,
    path: "",
    pageType: event.kind,
    sensitivity: event.sensitivity_hint ?? "unlabeled",
    taint: "quoted",
    authority: "connector_evidence",
    occurredAt: event.occurred_at,
    connectorId: event.connector_id,
    subjects: event.subjects.map(({ subject_id }) => subject_id),
    provenance: [eventId],
  };
}

const DOCUMENT_COLUMNS = `doc_id, scope, title, body, path, page_type, sensitivity,
       taint, authority, occurred_at, connector_id, subjects, provenance`;

function insertDocument(db: Database, doc: SearchDocument): void {
  db.query<
    never,
    [
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
      string,
      string,
      string,
    ]
  >(
    `INSERT OR REPLACE INTO search_documents (
       ${DOCUMENT_COLUMNS}
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    doc.docId,
    doc.scope,
    doc.title,
    doc.body,
    doc.path,
    doc.pageType,
    doc.sensitivity,
    doc.taint,
    doc.authority,
    doc.occurredAt,
    doc.connectorId,
    JSON.stringify(doc.subjects),
    JSON.stringify(doc.provenance),
  );
}

function insertFtsRow(db: Database, doc: SearchDocument): void {
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(
    doc.docId,
  );
  db.query<
    never,
    [
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
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO search_docs (
       ${DOCUMENT_COLUMNS}
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    doc.docId,
    doc.scope,
    doc.title,
    doc.body,
    doc.path,
    doc.pageType,
    doc.sensitivity,
    doc.taint,
    doc.authority,
    doc.occurredAt,
    doc.connectorId,
    JSON.stringify(doc.subjects),
    JSON.stringify(doc.provenance),
  );
}

export function insertDoc(db: Database, doc: SearchDocument): void {
  insertDocument(db, doc);
  insertFtsRow(db, doc);
}

export function deleteDoc(db: Database, scope: DocScope, docId: string): void {
  const id = namespaced(scope, docId);
  db.query<never, [string]>("DELETE FROM search_documents WHERE doc_id = ?").run(
    id,
  );
  db.query<never, [string]>("DELETE FROM search_docs WHERE doc_id = ?").run(id);
}

export function replacePage(db: Database, page: CanonPage): void {
  deleteDoc(db, "canon", page.id);
  if (!isLiveCanonPage(page)) return;
  insertDoc(db, pageDocument(page));
}

function replaceEvent(db: Database, event: CaptureEvent): void {
  deleteDoc(db, "ledger", event.event_id);
  if (event.deleted) {
    db.query<never, [string, string]>(
      `DELETE FROM search_docs
       WHERE scope = 'ledger' AND doc_id IN (
         SELECT 'event:' || event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
       )`,
    ).run(event.connector_id, event.source_record_id);
    db.query<never, [string, string]>(
      `DELETE FROM search_documents
       WHERE scope = 'ledger' AND doc_id IN (
         SELECT 'event:' || event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
       )`,
    ).run(event.connector_id, event.source_record_id);
    return;
  }
  insertDoc(db, eventDocument(event));
}

export function indexPage(db: Database, page: CanonPage): void {
  initSearch(db);
  db.transaction(() => replacePage(db, page)).immediate();
}

export function indexEvent(db: Database, event: CaptureEvent): void {
  initSearch(db);
  db.transaction(() => replaceEvent(db, event)).immediate();
}

export function removeDoc(db: Database, scope: DocScope, docId: string): void {
  initSearch(db);
  deleteDoc(db, scope, docId);
}

function stampSearch(
  db: Database,
  input: SearchRebuildInput,
  pageCount: number,
  eventCount: number,
): DerivedStamp {
  const watermark = latestLedgerCursor(db);
  return {
    layer: "search",
    generation: input.generation,
    rebuilt_at: input.rebuilt_at,
    doc_count: pageCount + eventCount,
    source_count: input.pages.length + eventCount,
    skipped_count: input.skipped.length,
    status: input.skipped.length > 0 ? "degraded" : "ok",
    ledger_watermark:
      watermark === null
        ? null
        : `${watermark.accepted_at}\t${watermark.event_id}`,
    canon_hash: input.canon_hash,
    port_id: "kizuki.retrieval.fts5",
    contract: "kizuki.retrieval/v1",
    space: null,
  };
}

/** FTS is a projection of search_documents. */
export function projectSearchDocs(db: Database): void {
  db.exec("DELETE FROM search_docs");
  db.exec(
    `INSERT INTO search_docs (${DOCUMENT_COLUMNS})
     SELECT ${DOCUMENT_COLUMNS} FROM search_documents`,
  );
}

/** Rebuild the search layer. Caller owns the transaction. */
export function rebuildSearchLayer(
  db: Database,
  input: SearchRebuildInput,
): SearchRebuildResult {
  const livePages = input.pages.filter(isLiveCanonPage);
  db.exec("DELETE FROM search_documents");
  for (const page of livePages) insertDocument(db, pageDocument(page));
  for (const event of replayLive(db, {})) {
    insertDocument(db, eventDocument(event));
  }
  projectSearchDocs(db);
  const counts = db
    .query<{ scope: string; count: number }, []>(
      "SELECT scope, count(*) AS count FROM search_documents GROUP BY scope",
    )
    .all();
  const pageCount = counts.find(({ scope }) => scope === "canon")?.count ?? 0;
  const eventCount = counts.find(({ scope }) => scope === "ledger")?.count ?? 0;
  stampDerived(db, stampSearch(db, input, pageCount, eventCount));
  return {
    pages: pageCount,
    events: eventCount,
    skipped: [...input.skipped],
    rebuilt_at: input.rebuilt_at,
    generation: input.generation,
    status: input.skipped.length > 0 ? "degraded" : "ok",
  };
}

export function rebuildSearch(
  db: Database,
  vaultPathOrInput: string | SearchRebuildInput,
): SearchRebuildResult {
  initSearch(db);
  const input: SearchRebuildInput =
    typeof vaultPathOrInput === "string"
      ? snapshotSearchInput(listCanonPagesReport(vaultPathOrInput))
      : vaultPathOrInput;
  return db.transaction(() => rebuildSearchLayer(db, input)).immediate();
}

function snapshotSearchInput(report: {
  pages: CanonPage[];
  skipped: SkippedPage[];
}): SearchRebuildInput {
  const live = report.pages.filter(isLiveCanonPage);
  return {
    generation: ulid(),
    pages: live,
    skipped: report.skipped,
    rebuilt_at: new Date().toISOString(),
    canon_hash: canonPagesHash(live),
  };
}
