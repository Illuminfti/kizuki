import type { Database } from "bun:sqlite";
import { EVENT_LIMITS } from "../contracts/event";
import { canonicalJson, sha256Hex } from "../util/hash";
import { REPLAY_PAGE_SIZE } from "./limits";
import { oneShotAll, oneShotGet, oneShotRun, tableColumns, tableExists } from "./schema";

/**
 * RFC 0002 §18.1 v5 fragment owned by purge-totality: `purge_ops` only.
 * Schedules, leases, budgets and retrieval_ops stay with serve-daemon.
 */
export const PURGE_SCHEMA_VERSION = 5;

export const PURGE_SLA_SECONDS = 3600;

const PROOF_DIGEST_CHECK = `proof_digest TEXT CHECK (
        proof_digest IS NULL
        OR (length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*')
      )`;

/** Independent receipt copy of a proof identity. Not a signature. */
export function eventPurgeProofDigest(
  contentHash: string,
  sourceRecordId: string,
  selectorKind: string | null,
): string {
  return sha256Hex(
    `kizuki.event-purge-proof/v1\0${canonicalJson({
      content_hash: contentHash,
      selector_kind: selectorKind,
      source_record_id: sourceRecordId,
    })}`,
  );
}

function ensureEventPurgeProofDigestColumn(db: Database): void {
  if (!tableExists(db, "event_purges")) return;
  if (tableColumns(db, "event_purges").includes("proof_digest")) return;
  db.exec(`ALTER TABLE event_purges ADD COLUMN ${PROOF_DIGEST_CHECK};`);
}

interface EventPurgeProofScan {
  receipt_id: string;
  proof_digest: string | null;
  content_hash: string;
  source_record_id: string;
  selector_kind: string | null;
}

const PROOF_SCAN = `SELECT e.receipt_id AS receipt_id, e.proof_digest AS proof_digest,
        x.content_hash AS content_hash, x.source_record_id AS source_record_id,
        x.selector_kind AS selector_kind
   FROM event_purges e
   JOIN event_purge_proofs x USING(receipt_id)`;

function eventPurgeProofPage(
  db: Database,
  after: string | null,
  pageSize: number,
): EventPurgeProofScan[] {
  return after === null
    ? oneShotAll<EventPurgeProofScan>(db, `${PROOF_SCAN} ORDER BY e.receipt_id LIMIT ?`, pageSize)
    : oneShotAll<EventPurgeProofScan>(
        db,
        `${PROOF_SCAN} WHERE e.receipt_id > ? ORDER BY e.receipt_id LIMIT ?`,
        after,
        pageSize,
      );
}

/** First receipt whose stored digest does not match currently stored proof bytes. */
export function findMismatchedEventPurgeProof(
  db: Database,
  pageSize: number,
): EventPurgeProofScan | null {
  let after: string | null = null;
  for (;;) {
    const rows = eventPurgeProofPage(db, after, pageSize);
    if (rows.length === 0) return null;
    for (const row of rows) {
      if (
        row.proof_digest !==
        eventPurgeProofDigest(row.content_hash, row.source_record_id, row.selector_kind)
      ) {
        return row;
      }
    }
    if (rows.length < pageSize) return null;
    after = rows[rows.length - 1]!.receipt_id;
  }
}

/** Bind currently stored proof bytes onto receipts that still lack a digest. */
export function bindStoredEventPurgeProofs(db: Database): void {
  ensureEventPurgeProofDigestColumn(db);
  if (
    !tableExists(db, "event_purges") ||
    !tableExists(db, "event_purge_proofs") ||
    !tableColumns(db, "event_purges").includes("proof_digest")
  ) {
    return;
  }
  for (;;) {
    const rows = oneShotAll<{
      receipt_id: string;
      content_hash: string;
      source_record_id: string;
      selector_kind: string | null;
    }>(
      db,
      `SELECT x.receipt_id AS receipt_id, x.content_hash AS content_hash,
              x.source_record_id AS source_record_id, x.selector_kind AS selector_kind
         FROM event_purge_proofs x
         JOIN event_purges e USING(receipt_id)
        WHERE e.proof_digest IS NULL
        ORDER BY e.receipt_id
        LIMIT ?`,
      REPLAY_PAGE_SIZE,
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      oneShotRun(
        db,
        "UPDATE event_purges SET proof_digest = ? WHERE receipt_id = ? AND proof_digest IS NULL",
        eventPurgeProofDigest(row.content_hash, row.source_record_id, row.selector_kind),
        row.receipt_id,
      );
    }
    if (rows.length < REPLAY_PAGE_SIZE) return;
  }
}

const PURGE_OPS_TABLE = `
CREATE TABLE IF NOT EXISTS purge_ops (
  op_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  store TEXT NOT NULL,
  ids TEXT NOT NULL,
  state TEXT NOT NULL,
  proof TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
`;

export function applyPurgeV5(db: Database): void {
  db.exec(PURGE_OPS_TABLE);
}

export function initPurgeOps(db: Database): void {
  if (tableExists(db, "purge_ops")) return;
  applyPurgeV5(db);
}

export function applyEventPurgeIntegrityV22(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_purge_proofs (
      receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes})
    ) STRICT;
  `);
}

/** Ledger v24: event-only selector provenance. Other families stay unrecorded. */
export function applyEventPurgeSelectorKindV24(db: Database): void {
  if (tableColumns(db, "event_purge_proofs").includes("selector_kind")) return;
  db.exec(`
    ALTER TABLE event_purge_proofs
      ADD COLUMN selector_kind TEXT
      CHECK (selector_kind IS NULL OR selector_kind = 'event');
  `);
}

/** Ledger v26: connector-only selector provenance. Compound selectors stay unrecorded. */
export function applyEventPurgeSelectorKindV26(db: Database): void {
  if (!tableExists(db, "event_purge_proofs")) return;
  const sql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_purge_proofs'",
  ).get()?.sql ?? "";
  if (sql.includes("'connector'")) return;
  db.exec(`
    CREATE TABLE event_purge_proofs_v26 (
      receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes}),
      selector_kind TEXT CHECK (selector_kind IS NULL OR selector_kind IN ('event', 'connector'))
    ) STRICT;
    INSERT INTO event_purge_proofs_v26 (receipt_id, content_hash, source_record_id, selector_kind)
      SELECT receipt_id, content_hash, source_record_id, selector_kind FROM event_purge_proofs;
    DROP TABLE event_purge_proofs;
    ALTER TABLE event_purge_proofs_v26 RENAME TO event_purge_proofs;
  `);
}

/** Ledger v27: source-record-only selector provenance. Compound selectors stay unrecorded. */
export function applyEventPurgeSelectorKindV27(db: Database): void {
  if (!tableExists(db, "event_purge_proofs")) return;
  const sql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_purge_proofs'",
  ).get()?.sql ?? "";
  if (sql.includes("'record'")) return;
  db.exec(`
    CREATE TABLE event_purge_proofs_v27 (
      receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes}),
      selector_kind TEXT CHECK (selector_kind IS NULL OR selector_kind IN ('event', 'connector', 'record'))
    ) STRICT;
    INSERT INTO event_purge_proofs_v27 (receipt_id, content_hash, source_record_id, selector_kind)
      SELECT receipt_id, content_hash, source_record_id, selector_kind FROM event_purge_proofs;
    DROP TABLE event_purge_proofs;
    ALTER TABLE event_purge_proofs_v27 RENAME TO event_purge_proofs;
  `);
}

/** Ledger v28: source-key-only selector provenance plus an independent receipt digest. */
export function applyEventPurgeSelectorKindV28(db: Database): void {
  if (tableExists(db, "event_purge_proofs")) {
    const sql = oneShotGet<{ sql: string | null }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_purge_proofs'",
    )?.sql ?? "";
    if (!sql.includes("'source'")) {
      db.exec(`
        CREATE TABLE event_purge_proofs_v28 (
          receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
          content_hash TEXT NOT NULL CHECK (
            length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
          ),
          source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes}),
          selector_kind TEXT CHECK (selector_kind IS NULL OR selector_kind IN ('event', 'connector', 'record', 'source'))
        ) STRICT;
        INSERT INTO event_purge_proofs_v28 (receipt_id, content_hash, source_record_id, selector_kind)
          SELECT receipt_id, content_hash, source_record_id, selector_kind FROM event_purge_proofs;
        DROP TABLE event_purge_proofs;
        ALTER TABLE event_purge_proofs_v28 RENAME TO event_purge_proofs;
      `);
    }
  }
  bindStoredEventPurgeProofs(db);
}
