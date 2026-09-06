import type { Database } from "bun:sqlite";
import { isAuthorityTier, type AuthorityTier } from "../contracts/proposal";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import { LedgerStoreError } from "./errors";
import { oneShotGet, tableColumns, tableExists } from "./schema";

export const SOURCE_SURVIVOR_LINEAGE_TABLE = "canon_source_survivor_lineage";
export const SOURCE_SURVIVOR_LINEAGE_BACKUP = "canon/source-survivor-lineage.v1.jsonl";
export const SOURCE_SURVIVOR_LINEAGE_KIND = "source_survivor" as const;
export const SOURCE_SURVIVOR_LINEAGE_VERSION = 1 as const;
export const MAX_SOURCE_SURVIVOR_LINEAGE_ROW_BYTES = 16 * 1024;
export const MAX_SOURCE_SURVIVOR_LINEAGE_ROWS = 100_000;
export const LINEAGE_UNAVAILABLE_WARNING =
  "backup lacks source-survivor lineage; still-verifiable ordinary history remains usable and already-sanitized survivor history remains withheld";

export const SOURCE_SURVIVOR_LINEAGE_COLUMNS = [
  "version",
  "kind",
  "child_receipt_id",
  "predecessor_receipt_id",
  "before_hash",
  "after_hash",
  "predecessor_effective_authority",
  "result_authority",
] as const;

const HASH = /^[0-9a-f]{64}$/;
const MAX_ID_BYTES = 1_024;
const MAX_TIMESTAMP_BYTES = 64;
const MAX_CHAIN_DEPTH = 128;
const AUTHORITY_SQL = "'owner_correction','owner_authored','connector_evidence','model_inference'";
const RECEIPT_COLUMNS = `receipt_id,page_path,receipt_kind,page_action,before_hash,after_hash,authority,reverts,writer,producer,archive_path,model_ref,at`;

export const SOURCE_SURVIVOR_LINEAGE_SQL = `CREATE TABLE canon_source_survivor_lineage (
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version = 1),
  kind TEXT NOT NULL CHECK (typeof(kind) = 'text' AND kind = 'source_survivor'),
  child_receipt_id TEXT NOT NULL CHECK (
    typeof(child_receipt_id) = 'text'
    AND length(CAST(child_receipt_id AS BLOB)) BETWEEN 1 AND 1024
  ),
  predecessor_receipt_id TEXT NOT NULL CHECK (
    typeof(predecessor_receipt_id) = 'text'
    AND length(CAST(predecessor_receipt_id AS BLOB)) BETWEEN 1 AND 1024
    AND predecessor_receipt_id != child_receipt_id
  ),
  before_hash TEXT NOT NULL CHECK (
    typeof(before_hash) = 'text'
    AND length(CAST(before_hash AS BLOB)) = 64
    AND before_hash NOT GLOB '*[^0-9a-f]*'
  ),
  after_hash TEXT NOT NULL CHECK (
    typeof(after_hash) = 'text'
    AND length(CAST(after_hash AS BLOB)) = 64
    AND after_hash NOT GLOB '*[^0-9a-f]*'
  ),
  predecessor_effective_authority TEXT NOT NULL CHECK (
    predecessor_effective_authority IN (${AUTHORITY_SQL})
  ),
  result_authority TEXT NOT NULL CHECK (
    result_authority IN (${AUTHORITY_SQL})
  ),
  PRIMARY KEY (child_receipt_id),
  FOREIGN KEY (child_receipt_id) REFERENCES canon_receipts(receipt_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (predecessor_receipt_id) REFERENCES canon_receipts(receipt_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT`;

export interface SourceSurvivorLineage {
  version: typeof SOURCE_SURVIVOR_LINEAGE_VERSION;
  kind: typeof SOURCE_SURVIVOR_LINEAGE_KIND;
  child_receipt_id: string;
  predecessor_receipt_id: string;
  before_hash: string;
  after_hash: string;
  predecessor_effective_authority: AuthorityTier;
  result_authority: AuthorityTier;
}

export interface LineageReceipt {
  receipt_id: string;
  page_path: string;
  receipt_kind: string;
  page_action: string;
  before_hash: string | null;
  after_hash: string;
  authority: string;
  reverts: string | null;
  writer: string;
  producer: string;
  archive_path: string | null;
  model_ref: string | null;
  at: string;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/; $/, "").trim().toLowerCase();
}

function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x80 && code <= 0x9f);
}

export function isLineageId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_ID_BYTES) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
      continue;
    }
    if ((code >= 0xdc00 && code <= 0xdfff) || isControlCode(code)) return false;
  }
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

export function isLineageHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function isLineageTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isRfc3339(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_TIMESTAMP_BYTES &&
    Number.isFinite(Date.parse(value))
  );
}

export function lineageReceiptEarlier(left: { at: string; receipt_id: string }, right: { at: string; receipt_id: string }): boolean {
  const a = Date.parse(left.at);
  const b = Date.parse(right.at);
  return Number.isFinite(a) && Number.isFinite(b) && (a < b || (a === b && left.receipt_id < right.receipt_id));
}

export function parseSourceSurvivorLineage(value: unknown): SourceSurvivorLineage {
  if (!isPlainObject(value)) throw new Error("source-survivor lineage is invalid");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...SOURCE_SURVIVOR_LINEAGE_COLUMNS].sort().join(",")) {
    throw new Error("source-survivor lineage keys are invalid");
  }
  const version = value["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version !== SOURCE_SURVIVOR_LINEAGE_VERSION) {
    throw new Error("source-survivor lineage version is invalid");
  }
  if (value["kind"] !== SOURCE_SURVIVOR_LINEAGE_KIND) {
    throw new Error("source-survivor lineage kind is invalid");
  }
  const child = value["child_receipt_id"];
  const predecessor = value["predecessor_receipt_id"];
  const before = value["before_hash"];
  const after = value["after_hash"];
  const predecessorAuthority = value["predecessor_effective_authority"];
  const resultAuthority = value["result_authority"];
  if (!isLineageId(child) || !isLineageId(predecessor) || child === predecessor) {
    throw new Error("source-survivor lineage receipt ids are invalid");
  }
  if (!isLineageHash(before) || !isLineageHash(after)) {
    throw new Error("source-survivor lineage hashes are invalid");
  }
  if (!isAuthorityTier(predecessorAuthority) || !isAuthorityTier(resultAuthority)) {
    throw new Error("source-survivor lineage authority is invalid");
  }
  return {
    version: SOURCE_SURVIVOR_LINEAGE_VERSION,
    kind: SOURCE_SURVIVOR_LINEAGE_KIND,
    child_receipt_id: child,
    predecessor_receipt_id: predecessor,
    before_hash: before,
    after_hash: after,
    predecessor_effective_authority: predecessorAuthority,
    result_authority: resultAuthority,
  };
}

export function lineageRecord(row: SourceSurvivorLineage): SourceSurvivorLineage {
  return {
    version: SOURCE_SURVIVOR_LINEAGE_VERSION,
    kind: SOURCE_SURVIVOR_LINEAGE_KIND,
    child_receipt_id: row.child_receipt_id,
    predecessor_receipt_id: row.predecessor_receipt_id,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    predecessor_effective_authority: row.predecessor_effective_authority,
    result_authority: row.result_authority,
  };
}

export function applySourceSurvivorLineageV20(db: Database): void {
  db.exec(SOURCE_SURVIVOR_LINEAGE_SQL);
}

export function assertSourceSurvivorLineageSchema(db: Database): void {
  if (
    !tableExists(db, SOURCE_SURVIVOR_LINEAGE_TABLE) ||
    JSON.stringify(tableColumns(db, SOURCE_SURVIVOR_LINEAGE_TABLE)) !==
      JSON.stringify(SOURCE_SURVIVOR_LINEAGE_COLUMNS) ||
    oneShotGet<{ strict: number }>(
      db,
      "SELECT strict FROM pragma_table_list WHERE name=?",
      SOURCE_SURVIVOR_LINEAGE_TABLE,
    )?.strict !== 1
  ) {
    throw new LedgerStoreError("corrupt", "source-survivor lineage schema is invalid");
  }
  const actual = oneShotGet<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    SOURCE_SURVIVOR_LINEAGE_TABLE,
  )?.sql;
  const sql = actual === undefined ? "" : normalizeSql(actual).replace(/ /g, "");
  if (
    sql === "" ||
    !sql.includes("strict") ||
    !sql.includes("version=1") ||
    !sql.includes("kind='source_survivor'") ||
    !sql.includes("referencescanon_receipts(receipt_id)") ||
    !sql.includes("ondeleterestrict") ||
    !sql.includes("onupdaterestrict") ||
    !sql.includes("predecessor_receipt_id!=child_receipt_id")
  ) {
    throw new LedgerStoreError("corrupt", "source-survivor lineage constraints are invalid");
  }
  if (oneShotGet(db, "SELECT 1 FROM pragma_foreign_key_check('canon_source_survivor_lineage') LIMIT 1") !== null) {
    throw new LedgerStoreError("corrupt", "source-survivor lineage references are invalid");
  }
}

export function sourceSurvivorLineageTableReady(db: Database): boolean {
  return tableExists(db, SOURCE_SURVIVOR_LINEAGE_TABLE);
}

export function getSourceSurvivorLineage(db: Database, childReceiptId: string): SourceSurvivorLineage | null {
  if (!sourceSurvivorLineageTableReady(db) || !isLineageId(childReceiptId)) return null;
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT ${SOURCE_SURVIVOR_LINEAGE_COLUMNS.join(",")} FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE} WHERE child_receipt_id=?`,
    )
    .get(childReceiptId);
  if (row === null) return null;
  return parseSourceSurvivorLineage(row);
}

export function readLineageReceipt(db: Database, receiptId: string): LineageReceipt | null {
  if (!tableExists(db, "canon_receipts") || !isLineageId(receiptId)) return null;
  return db
    .query<LineageReceipt, [string]>(`SELECT ${RECEIPT_COLUMNS} FROM canon_receipts WHERE receipt_id=?`)
    .get(receiptId);
}

export function sameUnredactedPage(left: string, right: string): boolean {
  return left !== "" && right !== "" && left === right;
}

function validWritePredecessor(row: LineageReceipt): boolean {
  return row.receipt_kind === "write" && row.reverts === null &&
    (row.before_hash === null || isLineageHash(row.before_hash));
}

function validPurgePredecessor(row: LineageReceipt): boolean {
  return row.receipt_kind === "purge_rewrite" && row.reverts === null && isLineageHash(row.before_hash);
}

function validRevertPredecessor(db: Database, row: LineageReceipt, childPath: string, seen: Set<string>): boolean {
  if (row.receipt_kind !== "revert" || row.reverts === null || !isLineageId(row.reverts) || seen.has(row.reverts)) {
    return false;
  }
  const target = readLineageReceipt(db, row.reverts);
  if (
    target === null ||
    !lineageReceiptEarlier(target, row) ||
    target.before_hash === null ||
    !isLineageHash(target.before_hash) ||
    !isLineageHash(target.after_hash) ||
    !isAuthorityTier(target.authority) ||
    row.before_hash !== target.after_hash ||
    row.after_hash !== target.before_hash
  ) {
    return false;
  }
  if (target.page_path !== "" && childPath !== "" && target.page_path !== childPath) return false;
  if (row.page_path !== "" && childPath !== "" && row.page_path !== childPath) return false;
  return true;
}

export function assertSurvivorChildReceipt(child: LineageReceipt, lineage: SourceSurvivorLineage): void {
  if (
    child.receipt_id !== lineage.child_receipt_id ||
    child.receipt_kind !== "purge_rewrite" ||
    child.page_action !== "edit" ||
    child.writer !== "loop" ||
    child.producer !== "deterministic" ||
    child.model_ref !== null ||
    child.reverts !== null ||
    child.archive_path !== null ||
    child.before_hash !== lineage.before_hash ||
    child.after_hash !== lineage.after_hash ||
    child.authority !== lineage.result_authority ||
    !isLineageHash(child.after_hash) ||
    !isLineageTimestamp(child.at)
  ) {
    throw new Error("source-survivor child receipt is invalid");
  }
}

function assertPredecessorKind(
  db: Database,
  predecessor: LineageReceipt,
  child: LineageReceipt,
  seen: Set<string>,
): void {
  const livePath = child.page_path !== "" ? child.page_path : predecessor.page_path;
  if (predecessor.page_path !== "" && child.page_path !== "" && predecessor.page_path !== child.page_path) {
    throw new Error("source-survivor predecessor page is invalid");
  }
  if (
    !isLineageTimestamp(predecessor.at) ||
    !lineageReceiptEarlier(predecessor, child) ||
    predecessor.after_hash === undefined
  ) {
    throw new Error("source-survivor predecessor chronology is invalid");
  }
  if (validWritePredecessor(predecessor) || validPurgePredecessor(predecessor)) return;
  if (validRevertPredecessor(db, predecessor, livePath, seen)) return;
  throw new Error("source-survivor predecessor kind is invalid");
}

export function assertSourceSurvivorLineageBinding(
  db: Database,
  lineage: SourceSurvivorLineage,
  seen: Set<string> = new Set(),
): void {
  if (seen.size >= MAX_CHAIN_DEPTH || seen.has(lineage.child_receipt_id)) {
    throw new Error("source-survivor lineage chain is invalid");
  }
  seen.add(lineage.child_receipt_id);
  const child = readLineageReceipt(db, lineage.child_receipt_id);
  const predecessor = readLineageReceipt(db, lineage.predecessor_receipt_id);
  if (child === null || predecessor === null) {
    throw new Error("source-survivor lineage reference is missing");
  }
  assertSurvivorChildReceipt(child, lineage);
  if (predecessor.after_hash !== lineage.before_hash || !isAuthorityTier(predecessor.authority)) {
    throw new Error("source-survivor predecessor binding is invalid");
  }
  assertPredecessorKind(db, predecessor, child, seen);
  const prior = getSourceSurvivorLineage(db, predecessor.receipt_id);
  if (prior !== null) {
    assertSourceSurvivorLineageBinding(db, prior, seen);
    if (prior.result_authority !== lineage.predecessor_effective_authority) {
      throw new Error("source-survivor predecessor authority is inconsistent");
    }
    return;
  }
  if (validWritePredecessor(predecessor) && predecessor.authority !== lineage.predecessor_effective_authority) {
    throw new Error("source-survivor predecessor authority is inconsistent");
  }
}

export function insertSourceSurvivorLineage(db: Database, value: SourceSurvivorLineage): void {
  const lineage = parseSourceSurvivorLineage(value);
  const existing = getSourceSurvivorLineage(db, lineage.child_receipt_id);
  if (existing !== null) {
    if (JSON.stringify(lineageRecord(existing)) !== JSON.stringify(lineageRecord(lineage))) {
      throw new Error("source-survivor lineage conflict");
    }
    return;
  }
  assertSourceSurvivorLineageBinding(db, lineage);
  db.query(
    `INSERT INTO ${SOURCE_SURVIVOR_LINEAGE_TABLE} (
      version, kind, child_receipt_id, predecessor_receipt_id,
      before_hash, after_hash, predecessor_effective_authority, result_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lineage.version,
    lineage.kind,
    lineage.child_receipt_id,
    lineage.predecessor_receipt_id,
    lineage.before_hash,
    lineage.after_hash,
    lineage.predecessor_effective_authority,
    lineage.result_authority,
  );
}

export function assertSourceSurvivorLineageGraph(db: Database): void {
  if (!sourceSurvivorLineageTableReady(db)) {
    throw new Error("source-survivor lineage schema is missing");
  }
  const count = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE}`)
    .get()?.n ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SOURCE_SURVIVOR_LINEAGE_ROWS) {
    throw new Error("source-survivor lineage exceeds its bound");
  }
  for (const row of db
    .query<Record<string, unknown>, []>(
      `SELECT ${SOURCE_SURVIVOR_LINEAGE_COLUMNS.join(",")} FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE}`,
    )
    .iterate()) {
    assertSourceSurvivorLineageBinding(db, parseSourceSurvivorLineage(row));
  }
}

export function* sourceSurvivorLineageExportRows(db: Database): Generator<SourceSurvivorLineage> {
  if (!sourceSurvivorLineageTableReady(db)) {
    throw new Error("source-survivor lineage schema is missing");
  }
  const count = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE}`)
    .get()?.n ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SOURCE_SURVIVOR_LINEAGE_ROWS) {
    throw new Error("source-survivor lineage exceeds its bound");
  }
  const fields = SOURCE_SURVIVOR_LINEAGE_COLUMNS.map((column) => {
    if (column === "version") {
      return `CASE WHEN typeof(version)='integer' AND version=1 THEN version ELSE NULL END AS version`;
    }
    return `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${MAX_SOURCE_SURVIVOR_LINEAGE_ROW_BYTES} THEN CAST(${column} AS BLOB) ELSE NULL END AS ${column}`;
  });
  let rows = 0;
  for (const stored of db
    .query<Record<string, unknown>, []>(
      `SELECT ${fields.join(",")} FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE} ORDER BY child_receipt_id COLLATE BINARY`,
    )
    .iterate()) {
    const decoded: Record<string, unknown> = {};
    for (const column of SOURCE_SURVIVOR_LINEAGE_COLUMNS) {
      const value = stored[column];
      if (value === null || value === undefined) throw new Error("invalid source-survivor lineage stored value");
      if (column === "version") {
        decoded[column] = value;
        continue;
      }
      if (!(value instanceof Uint8Array)) throw new Error("invalid source-survivor lineage stored value");
      decoded[column] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    }
    const row = lineageRecord(parseSourceSurvivorLineage(decoded));
    const encoded = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (encoded > MAX_SOURCE_SURVIVOR_LINEAGE_ROW_BYTES) {
      throw new Error("source-survivor lineage row exceeds its bound");
    }
    rows += 1;
    if (rows > MAX_SOURCE_SURVIVOR_LINEAGE_ROWS) {
      throw new Error("source-survivor lineage exceeds its bound");
    }
    yield row;
  }
  if (rows !== count) throw new Error("source-survivor lineage export drifted");
}

export function restoreSourceSurvivorLineageRow(db: Database, raw: Record<string, unknown>): void {
  insertSourceSurvivorLineage(db, parseSourceSurvivorLineage(raw));
}

/** Test helper: never used as a serving repair. */
export function lineageRowCount(db: Database): number {
  if (!sourceSurvivorLineageTableReady(db)) return 0;
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${SOURCE_SURVIVOR_LINEAGE_TABLE}`).get()?.n ?? 0;
}
