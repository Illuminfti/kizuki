import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { residualStageTraces } from "../canon/stage-recovery";
import { readCanonWriteIntent } from "../canon/write-intent";
import type { CanonFiles } from "../vault/canon-files";
import { eventIdFromReference } from "../retrieval/ids";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import { tableExists } from "./schema";
import { claimV2TablesPresent } from "./source-erasure";

/**
 * The stores purge answers for. Each verification emits exactly one proof per
 * store. `database` proves the ledger file itself was compacted and its
 * write-ahead log truncated, so freed pages cannot hold the erased text.
 */
export const PURGE_STORE_NAMES = [
  "events",
  "claims",
  "proposals",
  "search",
  "graph",
  "canon",
  "archive",
  "receipt_images",
  "database",
] as const;
export type PurgeStoreName = (typeof PURGE_STORE_NAMES)[number];

export interface PurgeStoreProof {
  store: PurgeStoreName;
  checked: number;
  /** Ids or vault-relative paths that still hold purged evidence. */
  found: string[];
  /**
   * Paths the proof could not read or scan. A store with any of these cannot be
   * shown clean, but they are not evidence: repair or remove the named file and
   * verify again.
   */
  unverifiable: string[];
  method: string;
  at: string;
}

export interface PurgeErasure {
  archive_copies: string[];
  claims: number;
  proposals: number;
  /** False when another connection kept the ledger from being compacted and truncated. */
  database_sealed: boolean;
}

const ULID_TOKEN = /[0-9A-HJKMNP-TV-Z]{26}/g;
const ARCHIVE_DIRECTORY = "archive";
const MIN_BODY_MATCH = 16;
/** Archive scans stay bounded: a larger directory or file fails closed as unverifiable. */
export const MAX_ARCHIVE_FILES = 20_000;
export const MAX_ARCHIVE_FILE_BYTES = 16 * 1_048_576;

function citedIds(text: string, ids: ReadonlySet<string>): boolean {
  for (const token of text.matchAll(ULID_TOKEN))
    if (ids.has(eventIdFromReference(token[0]))) return true;
  return false;
}

/**
 * Claims whose whole provenance is purged, whatever became of them since: a
 * superseded or skipped claim keeps its text as surely as a live one. Typed
 * claims lose their provenance on purge, so the batch time names them too.
 */
function scopeTablesPresent(db: Database): boolean {
  return tableExists(db, "purge_claim_scope") && claimV2TablesPresent(db);
}

/**
 * Record, before phase 1 deletes the evidence links, every typed claim whose
 * support named a purged event. Those links are the only path from such a claim
 * back to the purge, and they go with the event.
 */
export function capturePurgeClaimScope(db: Database, batchId: string, eventIds: readonly string[]): void {
  if (!scopeTablesPresent(db) || eventIds.length === 0) return;
  db.query(
    `INSERT OR IGNORE INTO purge_claim_scope (batch_id, claim_id)
     SELECT DISTINCT ?, s.claim_id FROM claim_v2_support s
       JOIN claim_v2_support_events e ON e.support_key = s.support_key
      WHERE e.event_id IN (SELECT value FROM json_each(?))`,
  ).run(batchId, JSON.stringify(eventIds));
}

const NO_SURVIVING_SUPPORT =
  "NOT EXISTS (SELECT 1 FROM claim_v2_support s JOIN claim_v2_support_events e ON e.support_key = s.support_key WHERE s.claim_id = claims.claim_id)";

/**
 * Typed claims whose every evidence link was purged are purged too, even when
 * their provenance column still names a surviving event. Returns their ids.
 */
export function markSupportPurgedClaims(db: Database, batchId: string, at: string): string[] {
  if (!scopeTablesPresent(db)) return [];
  const ids = db
    .query<{ claim_id: string }, [string]>(
      `SELECT claim_id FROM claims
        WHERE claim_id IN (SELECT claim_id FROM purge_claim_scope WHERE batch_id = ?)
          AND ${NO_SURVIVING_SUPPORT}
        ORDER BY claim_id`,
    )
    .all(batchId)
    .map((row) => row.claim_id);
  const mark = db.query("UPDATE claims SET status='purged', retracted_at=? WHERE claim_id=? AND status IN ('live', 'provenance_reduced')");
  for (const id of ids) mark.run(at, id);
  return ids;
}

/**
 * Claims whose whole provenance is purged, whatever became of them since: a
 * superseded or skipped claim keeps its text as surely as a live one. Typed
 * claims lose their provenance on purge, so the batch time names them too, and
 * so does the support scope captured before the evidence links went.
 */
function batchClaimIds(db: Database, batchId: string, eventIds: readonly string[]): string[] {
  if (!tableExists(db, "claims") || eventIds.length === 0) return [];
  const ids = new Set(
    db
      .query<{ claim_id: string }, [string, string]>(
        `SELECT claim_id FROM claims
          WHERE (status = 'purged' AND retracted_at IN (
                   SELECT e.purged_at FROM purge_batch_receipts m JOIN event_purges e USING(receipt_id) WHERE m.batch_id = ?))
             OR (EXISTS (SELECT 1 FROM json_each(claims.provenance) p WHERE p.value IN (SELECT value FROM json_each(?)))
                 AND NOT EXISTS (SELECT 1 FROM json_each(claims.provenance) p JOIN events e ON e.event_id = p.value))
          ORDER BY claim_id`,
      )
      .all(batchId, JSON.stringify(eventIds))
      .map((row) => row.claim_id),
  );
  if (scopeTablesPresent(db)) {
    for (const row of db
      .query<{ claim_id: string }, [string]>(
        `SELECT claim_id FROM claims
          WHERE claim_id IN (SELECT claim_id FROM purge_claim_scope WHERE batch_id = ?)
            AND ${NO_SURVIVING_SUPPORT}`,
      )
      .all(batchId)) ids.add(row.claim_id);
  }
  return [...ids].sort();
}

/** Scoped claims that kept other evidence but still hold anchors into a purged event. */
function orphanSupportClaims(db: Database, batchId: string): string[] {
  if (!scopeTablesPresent(db)) return [];
  return db
    .query<{ claim_id: string }, [string]>(
      `SELECT DISTINCT s.claim_id FROM claim_v2_support s
        WHERE s.claim_id IN (SELECT claim_id FROM purge_claim_scope WHERE batch_id = ?)
          AND NOT EXISTS (SELECT 1 FROM claim_v2_support_events e WHERE e.support_key = s.support_key)
        ORDER BY s.claim_id`,
    )
    .all(batchId)
    .map((row) => row.claim_id);
}

function batchProposalIds(db: Database, eventIds: readonly string[]): string[] {
  if (!tableExists(db, "proposals") || eventIds.length === 0) return [];
  return db
    .query<{ proposal_id: string }, [string]>(
      `SELECT proposal_id FROM proposals
        WHERE EXISTS (SELECT 1 FROM json_each(proposals.provenance) p WHERE p.value IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM json_each(proposals.provenance) p JOIN events e ON e.event_id = p.value)
        ORDER BY proposal_id`,
    )
    .all(JSON.stringify(eventIds))
    .map((row) => row.proposal_id);
}

function unblankedClaims(db: Database, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const semantics = claimV2TablesPresent(db)
    ? `OR EXISTS (SELECT 1 FROM claim_v2_semantics s WHERE s.claim_id = claims.claim_id)
       OR EXISTS (SELECT 1 FROM claim_v2_support s WHERE s.claim_id = claims.claim_id)`
    : "";
  return db
    .query<{ claim_id: string }, [string]>(
      `SELECT claim_id FROM claims
        WHERE claim_id IN (SELECT value FROM json_each(?))
          AND (body != '' OR frontmatter != '{}' OR object IS NOT NULL OR subject IS NOT NULL OR predicate IS NOT NULL
               OR target IS NOT NULL OR subjects != '[]' OR model_ref IS NOT NULL ${semantics})`,
    )
    .all(JSON.stringify(ids))
    .map((row) => row.claim_id);
}

function unblankedProposals(db: Database, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return db
    .query<{ proposal_id: string }, [string]>(
      "SELECT proposal_id FROM proposals WHERE proposal_id IN (SELECT value FROM json_each(?)) AND (body != '' OR frontmatter != '{}' OR target IS NOT NULL OR subjects != '[]')",
    )
    .all(JSON.stringify(ids))
    .map((row) => row.proposal_id);
}

function archiveNames(vaultPath: string): string[] {
  try {
    return readdirSync(join(vaultPath, ARCHIVE_DIRECTORY)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

interface ArchiveListing {
  /** Regular files small enough to read, in name order. */
  readable: string[];
  /** Files or the directory itself that a bounded scan cannot cover. */
  unverifiable: string[];
  entries: number;
}

function listArchive(vaultPath: string): ArchiveListing {
  const names = archiveNames(vaultPath);
  const listing: ArchiveListing = { readable: [], unverifiable: [], entries: names.length };
  if (names.length > MAX_ARCHIVE_FILES) {
    listing.unverifiable.push(`${ARCHIVE_DIRECTORY} (more than ${MAX_ARCHIVE_FILES} files)`);
    return listing;
  }
  for (const name of names) {
    const relPath = `${ARCHIVE_DIRECTORY}/${name}`;
    try {
      const stat = lstatSync(join(vaultPath, relPath));
      if (!stat.isFile()) continue;
      if (stat.size > MAX_ARCHIVE_FILE_BYTES) listing.unverifiable.push(`${relPath} (over ${MAX_ARCHIVE_FILE_BYTES} bytes)`);
      else listing.readable.push(relPath);
    } catch {
      listing.unverifiable.push(`${relPath} (unreadable)`);
    }
  }
  return listing;
}

function isRegularFile(vaultPath: string, relPath: string): boolean {
  try {
    return lstatSync(join(vaultPath, relPath)).isFile();
  } catch {
    return false;
  }
}

/** Purged claim text is known only until it is blanked, so archive erasure runs first. */
function purgedBodies(db: Database, claimIds: readonly string[]): string[] {
  if (claimIds.length === 0) return [];
  return db
    .query<{ body: string }, [string]>(
      "SELECT body FROM claims WHERE claim_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(claimIds))
    .map((row) => row.body.trim())
    .filter((body) => body.length >= MIN_BODY_MATCH);
}

/**
 * Delete archive copies that cite purged events or repeat a purged claim body.
 * Undo of the write that produced a deleted copy then refuses with a missing
 * archive instead of resurrecting purged text.
 */
function eraseArchiveCopies(
  files: CanonFiles,
  vaultPath: string,
  ids: ReadonlySet<string>,
  bodies: readonly string[],
): string[] {
  const erased: string[] = [];
  for (const relPath of listArchive(vaultPath).readable) {
    const snapshot = files.read(relPath);
    if (snapshot === null) continue;
    try {
      const text = Buffer.from(snapshot.bytes).toString("utf8");
      if (!citedIds(text, ids) && !bodies.some((body) => text.includes(body)))
        continue;
      files.remove(snapshot);
      erased.push(relPath);
    } finally {
      snapshot.close();
    }
  }
  return erased;
}

/**
 * Blank the personal payload of every claim and proposal whose whole
 * provenance is purged. Ids, provenance, hashes, status and receipts stay; the
 * body, frontmatter, object, subject, predicate and target go, so a later
 * capture of the same text cannot match the purged row. Callers hold the canon
 * writer fence and only call this once no held page still needs the claim text
 * to redact.
 */
export function erasePurgedPayloads(
  db: Database,
  files: CanonFiles,
  vaultPath: string,
  batchId: string,
  eventIds: readonly string[],
): Omit<PurgeErasure, "database_sealed"> {
  const claimIds = batchClaimIds(db, batchId, eventIds);
  const proposalIds = batchProposalIds(db, eventIds);
  const archive_copies = eraseArchiveCopies(
    files,
    vaultPath,
    new Set(eventIds),
    purgedBodies(db, claimIds),
  );
  db.transaction(() => {
    const blankClaim = db.query(
      `UPDATE claims SET body='', object=NULL, target=NULL, subject=NULL, predicate=NULL,
         subjects='[]', frontmatter='{}', model_ref=NULL WHERE claim_id=?`,
    );
    for (const id of claimIds) blankClaim.run(id);
    if (claimV2TablesPresent(db)) {
      const dropSemantics = db.query(
        "DELETE FROM claim_v2_semantics WHERE claim_id=?",
      );
      for (const id of claimIds) dropSemantics.run(id);
      // Support anchors are offsets into the purged event; a claim that lost
      // all its evidence keeps none, and one that kept some loses only the
      // anchors whose event links are gone.
      const dropSupport = db.query("DELETE FROM claim_v2_support WHERE claim_id=?");
      for (const id of claimIds) dropSupport.run(id);
      if (tableExists(db, "purge_claim_scope")) {
        db.query(
          `DELETE FROM claim_v2_support
            WHERE claim_id IN (SELECT claim_id FROM purge_claim_scope WHERE batch_id = ?)
              AND NOT EXISTS (SELECT 1 FROM claim_v2_support_events e WHERE e.support_key = claim_v2_support.support_key)`,
        ).run(batchId);
      }
    }
    const blankProposal = db.query(
      "UPDATE proposals SET body='', target=NULL, frontmatter='{}', subjects='[]', status='withdrawn' WHERE proposal_id=?",
    );
    for (const id of proposalIds) blankProposal.run(id);
  }).immediate();
  // Deleting a search row leaves its tokens in older FTS5 segments, and every
  // page revision the purged text ever passed through left one behind.
  if (tableExists(db, "search_docs")) db.exec("INSERT INTO search_docs(search_docs) VALUES ('rebuild')");
  return {
    archive_copies,
    claims: claimIds.length,
    proposals: proposalIds.length,
  };
}

function proof(
  store: PurgeStoreName,
  checked: number,
  found: string[],
  method: string,
  at: string,
  unverifiable: string[] = [],
): PurgeStoreProof {
  return {
    store,
    checked,
    found: [...new Set(found)].sort(),
    unverifiable: [...new Set(unverifiable)].sort(),
    method,
    at,
  };
}

function searchFound(db: Database, eventIds: readonly string[]): string[] {
  const events = JSON.stringify(eventIds);
  const documents = JSON.stringify(eventIds.map((id) => `event:${id}`));
  const found: string[] = [];
  for (const table of ["search_documents", "search_docs"] as const) {
    if (!tableExists(db, table)) continue;
    found.push(
      ...db
        .query<{ doc_id: string }, [string, string]>(
          `SELECT doc_id FROM ${table}
            WHERE doc_id IN (SELECT value FROM json_each(?))
               OR EXISTS (SELECT 1 FROM json_each(${table}.provenance) p
                          JOIN json_each(?) e ON p.value = e.value OR p.value = 'event:' || e.value)`,
        )
        .all(documents, events)
        .map((row) => row.doc_id),
    );
  }
  return found;
}

function graphFound(db: Database, eventIds: readonly string[]): string[] {
  if (!tableExists(db, "graph_edges")) return [];
  return db
    .query<{ edge: string }, [string]>(
      `WITH erased(id) AS (SELECT value FROM json_each(?))
       SELECT src || ' -> ' || dst AS edge FROM graph_edges
        WHERE src IN (SELECT 'event:' || id FROM erased UNION ALL SELECT id FROM erased)
           OR dst IN (SELECT 'event:' || id FROM erased UNION ALL SELECT id FROM erased)
           OR EXISTS (SELECT 1 FROM json_each(graph_edges.provenance) p JOIN erased e ON p.value = e.id OR p.value = 'event:' || e.id)`,
    )
    .all(JSON.stringify(eventIds))
    .map((row) => row.edge);
}

function canonFound(
  db: Database,
  vaultPath: string,
  batchId: string,
  ids: ReadonlySet<string>,
): { found: string[]; unverifiable: string[] } {
  const report = listCanonPagesReport(vaultPath);
  const found = report.pages
    .filter((page) =>
      stringArray(page.data["sources"]).some((source) =>
        ids.has(eventIdFromReference(source)),
      ),
    )
    .map((page) => page.relPath);
  if (tableExists(db, "canon_holds")) {
    found.push(
      ...db
        .query<{ page_path: string }, [string]>(
          "SELECT page_path FROM canon_holds WHERE proposal_id = ?",
        )
        .all(batchId)
        .map((row) => row.page_path),
    );
  }
  // A page the walk could not read cannot be shown clean. It is not evidence
  // either, so it is named apart from the pages that hold purged sources.
  const unverifiable = report.skipped
    .filter((entry) => entry.code !== "invalid" && entry.code !== "oversize")
    .map((entry) => `${entry.relPath} (${entry.code})`);
  if (report.truncated) unverifiable.push("canon walk (truncated at its page limit)");
  return { found, unverifiable };
}

function archiveFound(
  vaultPath: string,
  ids: ReadonlySet<string>,
  files: CanonFiles,
): { found: string[]; unverifiable: string[]; checked: number } {
  const listing = listArchive(vaultPath);
  const found: string[] = [];
  const unverifiable = [...listing.unverifiable];
  for (const relPath of listing.readable) {
    let snapshot;
    try {
      snapshot = files.read(relPath);
    } catch {
      unverifiable.push(`${relPath} (unreadable)`);
      continue;
    }
    if (snapshot === null) continue;
    try {
      if (citedIds(Buffer.from(snapshot.bytes).toString("utf8"), ids))
        found.push(relPath);
    } finally {
      snapshot.close();
    }
  }
  return { found, unverifiable, checked: listing.entries };
}

/** A pending write intent embeds whole before and after page images. */
function intentFound(db: Database, ids: ReadonlySet<string>): string[] {
  if (!tableExists(db, "canon_write_intents")) return [];
  const pending = db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_write_intents").get();
  if (pending === null) return [];
  try {
    const intent = readCanonWriteIntent(db);
    return intent !== null && intent.receipt.provenance.some((id) => ids.has(eventIdFromReference(id))) ? [pending.receipt_id] : [];
  } catch { return [pending.receipt_id]; }
}

function withShortBusyTimeout<T>(db: Database, work: () => T): T {
  const before = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout;
  db.exec("PRAGMA busy_timeout=2000");
  try { return work(); }
  finally { db.exec(`PRAGMA busy_timeout=${before}`); }
}

/**
 * Rewrite the ledger file without its free space: pages freed before this purge
 * ran were not overwritten, and only a rewrite drops them. False when another
 * connection kept it from running.
 */
export function compactLedger(db: Database): boolean {
  try { withShortBusyTimeout(db, () => db.exec("VACUUM")); return true; }
  catch { return false; }
}

/** Fold the write-ahead log into the file and truncate it. False when a reader blocked it. */
export function truncateLedgerLog(db: Database): boolean {
  try {
    return withShortBusyTimeout(db, () => db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0);
  } catch { return false; }
}

/**
 * One proof per store. Text is gone by the time this runs, so proofs are keyed
 * by the purged event ids and by the blank state of the rows that cited them.
 */
export function proveLocalStores(
  db: Database,
  files: CanonFiles,
  vaultPath: string,
  batchId: string,
  eventIds: readonly string[],
  at: string,
  logTruncated: boolean,
): PurgeStoreProof[] {
  const ids = new Set(eventIds);
  const claimIds = batchClaimIds(db, batchId, eventIds);
  const proposalIds = batchProposalIds(db, eventIds);
  const canon = canonFound(db, vaultPath, batchId, ids);
  const archive = archiveFound(vaultPath, ids, files);
  const present =
    eventIds.length === 0
      ? []
      : db
          .query<{ event_id: string }, [string]>(
            "SELECT event_id FROM events WHERE event_id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(eventIds))
          .map((row) => row.event_id);
  return [
    proof("events", eventIds.length, present, "ledger-rows", at),
    proof(
      "claims",
      claimIds.length,
      [...unblankedClaims(db, claimIds), ...orphanSupportClaims(db, batchId)],
      "blank-payload",
      at,
    ),
    proof(
      "proposals",
      proposalIds.length,
      unblankedProposals(db, proposalIds),
      "blank-payload",
      at,
    ),
    proof(
      "search",
      eventIds.length,
      searchFound(db, eventIds),
      "provenance-scan",
      at,
    ),
    proof(
      "graph",
      eventIds.length,
      graphFound(db, eventIds),
      "provenance-scan",
      at,
    ),
    proof(
      "canon",
      eventIds.length,
      canon.found,
      "page-sources-and-holds",
      at,
      canon.unverifiable,
    ),
    proof(
      "archive",
      archive.checked,
      archive.found,
      "archive-sources-scan",
      at,
      archive.unverifiable,
    ),
    proof(
      "receipt_images",
      eventIds.length,
      [...residualStageTraces(db, vaultPath), ...intentFound(db, ids)],
      "stage-traces-and-intents",
      at,
    ),
    proof(
      "database",
      1,
      logTruncated ? [] : ["ledger_files_busy"],
      "wal_checkpoint(TRUNCATE)",
      at,
    ),
  ];
}
