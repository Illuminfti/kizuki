import type { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { rebuildPageIndex } from "./canon";
import { CANON_SCHEMA_VERSION } from "./canon/schema";
import {
  type CanonReceiptRow,
  rowToReceipt,
} from "./canon/receipts";
import { CLAIMS_SCHEMA_VERSION, syncCompatProposals } from "./claims/schema";
import { rebuildDerived } from "./derived";
import { validateEventInput } from "./contracts/event";
import { computeContentHash } from "./util/hash";
import { ulid } from "./util/ulid";
import { LEDGER_SCHEMA_VERSION, openLedger } from "./ledger/db";
import { PURGE_SCHEMA_VERSION } from "./ledger/purge-schema";
import { tableExists } from "./ledger/schema";
import { SENSITIVITY_SCHEMA_VERSION } from "./sensitivity/schema";
import { SERVE_SCHEMA_VERSION } from "./serve/types";
import { readVaultId, vaultIdPath } from "./serve/vault-id";
import { doctorVault } from "./vault/doctor";
import { initVault } from "./vault/init";

export const BACKUP_SCHEMA = "kizuki.backup/v1" as const;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PAGE = 256;
const CHUNK = 65_536;
const STAGING_MARK = ".kizuki-backup-";
const INCOMPLETE = ".kizuki-backup-incomplete";
const FORBIDDEN_KEYS = new Set([
  "resolved_secret",
  "client_secret",
  "access_token",
  "refresh_token",
  "api_key",
  "password",
]);

export interface ExportManifestEntry {
  count: number;
  sha256: string;
  size: number;
  mode: number;
}

export interface BackupSchemaVersions {
  ledger: number;
  claims: number;
  canon: number;
  purge: number;
  sensitivity: number;
  serve: number;
}

export interface BackupSnapshot {
  last_event_id: string | null;
  last_accepted_at: string | null;
  event_count: number;
}

export interface ExportManifest {
  schema: typeof BACKUP_SCHEMA;
  vault_id: string | null;
  created_at: string;
  schema_versions: BackupSchemaVersions;
  snapshot: BackupSnapshot;
  complete: boolean;
  files: Record<string, ExportManifestEntry>;
  manifest_sha256: string;
}

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
}

export interface RestoreReport {
  vault_id: string | null;
  events: number;
  claims: number;
  receipts: number;
  vault_files: number;
  doctor: { total: number; valid: number; invalid: number };
}

interface EventRow {
  event_id: string;
  connector_id: string;
  source_record_id: string;
  kind: string;
  occurred_at: string;
  observed_at: string;
  text: string;
  subjects: string;
  sensitivity_hint: string | null;
  deleted: number;
  attachments: string;
  metadata: string;
  content_hash: string;
  accepted_at: string;
}

interface PurgeRow {
  receipt_id: string;
  event_id: string;
  connector_id: string;
  reason: string;
  purged_at: string;
}

interface ClaimRow {
  claim_id: string;
  kind: string;
  target: string | null;
  body: string;
  frontmatter: string;
  provenance: string;
  subjects: string;
  producer: string;
  confidence: number;
  status: string;
  created_at: string;
  body_hash: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  polarity: string;
  claim_key: string | null;
  authority: string;
  sensitivity: string | null;
  taint: string;
  model_ref: string | null;
  valid_from: string;
  valid_to: string | null;
  asserted_at: string;
  retracted_at: string | null;
  superseded_by: string | null;
  receipt_id: string | null;
  corroboration: number;
  last_confirmed_at: string | null;
}

interface ConnectionRow {
  connector_id: string;
  source_key: string;
  config: string;
  secret_refs: string;
  connected_at: string;
  disconnected_at: string | null;
}

interface CheckpointRow {
  connector_id: string;
  source_key: string;
  cursor: string | null;
  mode: string;
  updated_at: string;
  last_run_at: string;
  last_result: string;
}

interface SupersessionRow {
  winner: string;
  loser: string;
  rule: string;
  prior_valid_to: string | null;
  receipt_id: string;
  at: string;
}

interface BindingRow {
  claim_key: string;
  page_id: string;
  bound_at: string;
}

const EVENT_COLUMNS = `
  event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
  text, subjects, sensitivity_hint, deleted, attachments, metadata,
  content_hash, accepted_at
`;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("export cancelled");
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("backup write made no progress");
    offset += written;
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function mkdirPrivate(path: string): void {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new Error(`backup path is not a directory: ${path}`);
    }
    return;
  }
  const parent = dirname(path);
  if (parent !== path && !existsSync(parent)) mkdirPrivate(parent);
  mkdirSync(path, { mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  mkdirPrivate(dirname(path));
  const fd = openSync(path, "wx", FILE_MODE);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, FILE_MODE);
}

function copyHashed(
  source: string,
  destination: string,
): { sha256: string; size: number } {
  mkdirPrivate(dirname(destination));
  const hasher = new Bun.CryptoHasher("sha256");
  const input = openSync(source, "r");
  const output = openSync(destination, "wx", FILE_MODE);
  let size = 0;
  try {
    const buf = Buffer.alloc(CHUNK);
    let read = readSync(input, buf);
    while (read > 0) {
      const slice = buf.subarray(0, read);
      hasher.update(slice);
      writeAll(output, slice);
      size += read;
      read = readSync(input, buf);
    }
    fsyncSync(output);
  } finally {
    closeSync(input);
    closeSync(output);
  }
  chmodSync(destination, FILE_MODE);
  return { sha256: hasher.digest("hex"), size };
}

function hashFile(path: string): { sha256: string; size: number } {
  const hasher = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "r");
  let size = 0;
  try {
    const buf = Buffer.alloc(CHUNK);
    let read = readSync(fd, buf);
    while (read > 0) {
      hasher.update(buf.subarray(0, read));
      size += read;
      read = readSync(fd, buf);
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hasher.digest("hex"), size };
}

function resolveExisting(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  let current = dirname(absolute);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
  return resolve(realpathSync(current), relative(current, absolute));
}

function isInside(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
}

function splitBackupPath(key: string): string[] {
  if (key.includes("\0")) {
    throw new Error(`backup file path is invalid: ${key}`);
  }
  const parts = key.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`backup file path is invalid: ${key}`);
  }
  return parts;
}

function pathUnder(root: string, parts: string[]): string {
  const dest = resolve(root, ...parts);
  if (!isInside(dest, resolve(root))) {
    throw new Error(`backup file path is invalid: ${parts.join("/")}`);
  }
  return dest;
}

function assertSeparated(source: string, destination: string): void {
  const from = resolveExisting(source);
  const to = resolveExisting(destination);
  if (isInside(to, from) || isInside(from, to)) {
    throw new Error(
      "export destination must not be inside the vault or contain it",
    );
  }
}

function isEmptyDirectory(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

function prepareDestination(outDir: string): void {
  if (!existsSync(outDir)) return;
  const info = lstatSync(outDir);
  if (info.isSymbolicLink()) {
    throw new Error(`export destination is a symlink: ${outDir}`);
  }
  if (!info.isDirectory() || !isEmptyDirectory(outDir)) {
    throw new Error(`export output directory is not empty: ${outDir}`);
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`export destination is not owner-only: ${outDir}`);
  }
}

function installStaging(staging: string, destination: string): void {
  if (existsSync(destination)) {
    prepareDestination(destination);
    rmdirSync(destination);
  }
  renameSync(staging, destination);
}

function vaultFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => compareCodeUnits(left.name, right.name),
  )) {
    if (entry.name === ".kizuki" || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...vaultFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function ledgerSchemaVersion(db: Database): number {
  return (
    db
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get()?.version ?? 0
  );
}

function supportedSchemaVersions(ledgerVersion = LEDGER_SCHEMA_VERSION): BackupSchemaVersions {
  return {
    ledger: ledgerVersion,
    claims: CLAIMS_SCHEMA_VERSION,
    canon: CANON_SCHEMA_VERSION,
    purge: PURGE_SCHEMA_VERSION,
    sensitivity: SENSITIVITY_SCHEMA_VERSION,
    serve: SERVE_SCHEMA_VERSION,
  };
}

function eventRecord(row: EventRow): Record<string, unknown> {
  return {
    schema: "kizuki.event/v1",
    event_id: row.event_id,
    connector_id: row.connector_id,
    source_record_id: row.source_record_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    text: row.text,
    subjects: JSON.parse(row.subjects) as unknown,
    ...(row.sensitivity_hint === null
      ? {}
      : { sensitivity_hint: row.sensitivity_hint }),
    deleted: row.deleted === 1,
    attachments: JSON.parse(row.attachments) as unknown,
    metadata: JSON.parse(row.metadata) as unknown,
    content_hash: row.content_hash,
    accepted_at: row.accepted_at,
  };
}

function claimRecord(row: ClaimRow): Record<string, unknown> {
  return {
    schema: "kizuki.claim/v1",
    claim_id: row.claim_id,
    kind: row.kind,
    target: row.target,
    body: row.body,
    frontmatter: JSON.parse(row.frontmatter) as unknown,
    provenance: JSON.parse(row.provenance) as unknown,
    subjects: JSON.parse(row.subjects) as unknown,
    producer: row.producer,
    confidence: row.confidence,
    status: row.status,
    created_at: row.created_at,
    body_hash: row.body_hash,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    polarity: row.polarity,
    claim_key: row.claim_key,
    authority: row.authority,
    sensitivity: row.sensitivity,
    taint: row.taint,
    model_ref: row.model_ref,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    asserted_at: row.asserted_at,
    retracted_at: row.retracted_at,
    superseded_by: row.superseded_by,
    receipt_id: row.receipt_id,
    corroboration: row.corroboration,
    last_confirmed_at: row.last_confirmed_at,
  };
}

function* pageEvents(
  db: Database,
  snapshot: BackupSnapshot,
): Generator<Record<string, unknown>> {
  if (snapshot.last_event_id === null || snapshot.last_accepted_at === null) {
    return;
  }
  const capAt = snapshot.last_accepted_at;
  const capId = snapshot.last_event_id;
  let cursor: { accepted_at: string; event_id: string } | null = null;
  while (true) {
    let rows: EventRow[];
    if (cursor === null) {
      rows = db
        .query<EventRow, [string, string, string, number]>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE accepted_at < ?
              OR (accepted_at = ? AND event_id <= ?)
           ORDER BY accepted_at, event_id LIMIT ?`,
        )
        .all(capAt, capAt, capId, PAGE);
    } else {
      rows = db
        .query<EventRow, [string, string, string, string, string, string, number]>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE (accepted_at > ?
              OR (accepted_at = ? AND event_id > ?))
             AND (accepted_at < ?
              OR (accepted_at = ? AND event_id <= ?))
           ORDER BY accepted_at, event_id LIMIT ?`,
        )
        .all(
          cursor.accepted_at,
          cursor.accepted_at,
          cursor.event_id,
          capAt,
          capAt,
          capId,
          PAGE,
        );
    }
    if (rows.length === 0) break;
    for (const row of rows) yield eventRecord(row);
    const last: EventRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { accepted_at: last.accepted_at, event_id: last.event_id };
  }
}

function* pagePurges(db: Database): Generator<PurgeRow> {
  let cursor: { purged_at: string; receipt_id: string } | null = null;
  while (true) {
    let rows: PurgeRow[];
    if (cursor === null) {
      rows = db
        .query<PurgeRow, [number]>(
          `SELECT receipt_id, event_id, connector_id, reason, purged_at
           FROM event_purges ORDER BY purged_at, receipt_id LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<PurgeRow, [string, string, string, number]>(
          `SELECT receipt_id, event_id, connector_id, reason, purged_at
           FROM event_purges
           WHERE purged_at > ?
              OR (purged_at = ? AND receipt_id > ?)
           ORDER BY purged_at, receipt_id LIMIT ?`,
        )
        .all(cursor.purged_at, cursor.purged_at, cursor.receipt_id, PAGE);
    }
    if (rows.length === 0) break;
    yield* rows;
    const last: PurgeRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { purged_at: last.purged_at, receipt_id: last.receipt_id };
  }
}

function* pageClaims(db: Database): Generator<Record<string, unknown>> {
  if (!tableExists(db, "claims")) return;
  let cursor: { created_at: string; claim_id: string } | null = null;
  while (true) {
    let rows: ClaimRow[];
    if (cursor === null) {
      rows = db
        .query<ClaimRow, [number]>(
          "SELECT * FROM claims ORDER BY created_at, claim_id LIMIT ?",
        )
        .all(PAGE);
    } else {
      rows = db
        .query<ClaimRow, [string, string, string, number]>(
          `SELECT * FROM claims
           WHERE created_at > ?
              OR (created_at = ? AND claim_id > ?)
           ORDER BY created_at, claim_id LIMIT ?`,
        )
        .all(cursor.created_at, cursor.created_at, cursor.claim_id, PAGE);
    }
    if (rows.length === 0) break;
    for (const row of rows) yield claimRecord(row);
    const last: ClaimRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { created_at: last.created_at, claim_id: last.claim_id };
  }
}

function* pageSupersessions(db: Database): Generator<SupersessionRow> {
  if (!tableExists(db, "claim_supersessions")) return;
  let cursor: { winner: string; loser: string } | null = null;
  while (true) {
    let rows: SupersessionRow[];
    if (cursor === null) {
      rows = db
        .query<SupersessionRow, [number]>(
          `SELECT winner, loser, rule, prior_valid_to, receipt_id, at
           FROM claim_supersessions ORDER BY winner, loser LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<SupersessionRow, [string, string, string, number]>(
          `SELECT winner, loser, rule, prior_valid_to, receipt_id, at
           FROM claim_supersessions
           WHERE winner > ?
              OR (winner = ? AND loser > ?)
           ORDER BY winner, loser LIMIT ?`,
        )
        .all(cursor.winner, cursor.winner, cursor.loser, PAGE);
    }
    if (rows.length === 0) break;
    yield* rows;
    const last: SupersessionRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { winner: last.winner, loser: last.loser };
  }
}

function* pageBindings(db: Database): Generator<BindingRow> {
  if (!tableExists(db, "claim_bindings")) return;
  let cursor: { claim_key: string; page_id: string } | null = null;
  while (true) {
    let rows: BindingRow[];
    if (cursor === null) {
      rows = db
        .query<BindingRow, [number]>(
          `SELECT claim_key, page_id, bound_at
           FROM claim_bindings ORDER BY claim_key, page_id LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<BindingRow, [string, string, string, number]>(
          `SELECT claim_key, page_id, bound_at
           FROM claim_bindings
           WHERE claim_key > ?
              OR (claim_key = ? AND page_id > ?)
           ORDER BY claim_key, page_id LIMIT ?`,
        )
        .all(cursor.claim_key, cursor.claim_key, cursor.page_id, PAGE);
    }
    if (rows.length === 0) break;
    yield* rows;
    const last: BindingRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { claim_key: last.claim_key, page_id: last.page_id };
  }
}

function receiptRecord(row: CanonReceiptRow): Record<string, unknown> {
  return { ...rowToReceipt(row), claim_kind: row.kind };
}

function* pageReceipts(db: Database): Generator<Record<string, unknown>> {
  if (!tableExists(db, "canon_receipts")) return;
  let cursor: { at: string; receipt_id: string } | null = null;
  while (true) {
    let rows: CanonReceiptRow[];
    if (cursor === null) {
      rows = db
        .query<CanonReceiptRow, [number]>(
          "SELECT * FROM canon_receipts ORDER BY at, receipt_id LIMIT ?",
        )
        .all(PAGE);
    } else {
      rows = db
        .query<CanonReceiptRow, [string, string, string, number]>(
          `SELECT * FROM canon_receipts
           WHERE at > ?
              OR (at = ? AND receipt_id > ?)
           ORDER BY at, receipt_id LIMIT ?`,
        )
        .all(cursor.at, cursor.at, cursor.receipt_id, PAGE);
    }
    if (rows.length === 0) break;
    for (const row of rows) yield receiptRecord(row);
    const last: CanonReceiptRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    cursor = { at: last.at, receipt_id: last.receipt_id };
  }
}

function* pageConnections(db: Database): Generator<Record<string, unknown>> {
  let after: { connector_id: string; source_key: string } | null = null;
  while (true) {
    let rows: ConnectionRow[];
    if (after === null) {
      rows = db
        .query<ConnectionRow, [number]>(
          `SELECT * FROM connections
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<ConnectionRow, [string, string, string, number]>(
          `SELECT * FROM connections
           WHERE connector_id > ?
              OR (connector_id = ? AND source_key > ?)
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(after.connector_id, after.connector_id, after.source_key, PAGE);
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      yield {
        connector_id: row.connector_id,
        source_key: row.source_key,
        config: JSON.parse(row.config) as unknown,
        secret_refs: JSON.parse(row.secret_refs) as unknown,
        connected_at: row.connected_at,
        disconnected_at: row.disconnected_at,
      };
    }
    const last: ConnectionRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    after = { connector_id: last.connector_id, source_key: last.source_key };
  }
}

function* pageCheckpoints(db: Database): Generator<Record<string, unknown>> {
  let after: { connector_id: string; source_key: string } | null = null;
  while (true) {
    let rows: CheckpointRow[];
    if (after === null) {
      rows = db
        .query<CheckpointRow, [number]>(
          `SELECT * FROM checkpoints
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<CheckpointRow, [string, string, string, number]>(
          `SELECT * FROM checkpoints
           WHERE connector_id > ?
              OR (connector_id = ? AND source_key > ?)
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(after.connector_id, after.connector_id, after.source_key, PAGE);
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      yield {
        connector_id: row.connector_id,
        source_key: row.source_key,
        cursor: row.cursor,
        mode: row.mode,
        updated_at: row.updated_at,
        last_run_at: row.last_run_at,
        last_result: JSON.parse(row.last_result) as unknown,
      };
    }
    const last: CheckpointRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    after = { connector_id: last.connector_id, source_key: last.source_key };
  }
}

function writeJsonl(
  path: string,
  rows: Iterable<unknown>,
  signal?: AbortSignal,
): number {
  mkdirPrivate(dirname(path));
  const fd = openSync(path, "wx", FILE_MODE);
  let count = 0;
  try {
    for (const row of rows) {
      throwIfAborted(signal);
      refuseSecrets(row, path);
      writeAll(fd, Buffer.from(`${JSON.stringify(row)}\n`));
      count += 1;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, FILE_MODE);
  return count;
}

function refuseSecrets(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) refuseSecrets(item, path);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`backup refused a credential field in ${path}`);
    }
    refuseSecrets(nested, path);
  }
}

function* readJsonl(path: string): Generator<unknown> {
  const fd = openSync(path, "r");
  let leftover = Buffer.alloc(0);
  try {
    const buf = Buffer.alloc(CHUNK);
    let read = readSync(fd, buf);
    while (read > 0) {
      leftover = Buffer.concat([leftover, buf.subarray(0, read)]);
      let newline = leftover.indexOf(0x0a);
      while (newline !== -1) {
        const line = leftover.subarray(0, newline);
        leftover = leftover.subarray(newline + 1);
        if (line.byteLength > 0) yield JSON.parse(line.toString("utf8"));
        newline = leftover.indexOf(0x0a);
      }
      read = readSync(fd, buf);
    }
    if (leftover.byteLength > 0) yield JSON.parse(leftover.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function trackFile(
  files: Record<string, ExportManifestEntry>,
  relativePath: string,
  count: number,
  hashed: { sha256: string; size: number },
): void {
  files[relativePath] = {
    count,
    sha256: hashed.sha256,
    size: hashed.size,
    mode: FILE_MODE,
  };
}

function sortedFiles(
  files: Record<string, ExportManifestEntry>,
): Record<string, ExportManifestEntry> {
  const sorted: Record<string, ExportManifestEntry> = {};
  for (const key of Object.keys(files).sort(compareCodeUnits)) {
    const entry = files[key];
    if (entry !== undefined) sorted[key] = entry;
  }
  return sorted;
}

function unsignedManifest(
  manifest: Omit<ExportManifest, "manifest_sha256">,
): Omit<ExportManifest, "manifest_sha256"> {
  return {
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files: sortedFiles(manifest.files),
  };
}

function manifestBytes(
  manifest: Omit<ExportManifest, "manifest_sha256">,
): Uint8Array {
  return Buffer.from(`${JSON.stringify(unsignedManifest(manifest), null, 2)}\n`);
}

function signManifest(
  manifest: Omit<ExportManifest, "manifest_sha256">,
): ExportManifest {
  const bytes = manifestBytes(manifest);
  return {
    ...unsignedManifest(manifest),
    manifest_sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
}

function snapshotOf(db: Database): BackupSnapshot {
  const last = db
    .query<
      { event_id: string; accepted_at: string },
      []
    >("SELECT event_id, accepted_at FROM events ORDER BY accepted_at DESC, event_id DESC LIMIT 1")
    .get();
  const event_count =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
      ?.count ?? 0;
  return {
    last_event_id: last?.event_id ?? null,
    last_accepted_at: last?.accepted_at ?? null,
    event_count,
  };
}

function writeStream(
  outDir: string,
  relativePath: string,
  rows: Iterable<unknown>,
  files: Record<string, ExportManifestEntry>,
  signal?: AbortSignal,
): void {
  const path = join(outDir, relativePath);
  const count = writeJsonl(path, rows, signal);
  trackFile(files, relativePath, count, hashFile(path));
}

export function exportVault(
  db: Database,
  vaultPath: string,
  outDir: string,
  options: ExportOptions = {},
): ExportManifest {
  throwIfAborted(options.signal);
  const source = resolve(vaultPath);
  const destination = resolve(outDir);
  assertSeparated(source, destination);
  prepareDestination(destination);
  const parent = dirname(destination);
  mkdirPrivate(parent);

  const staging = join(parent, `${basenameSafe(destination)}${STAGING_MARK}${ulid()}.partial`);
  mkdirPrivate(staging);
  writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
  options.onProgress?.("staging");

  try {
    const files: Record<string, ExportManifestEntry> = {};
    for (const sourceFile of vaultFiles(source)) {
      throwIfAborted(options.signal);
      options.onProgress?.("vault");
      const rel = posixRel(source, sourceFile);
      const destFile = join(staging, "vault", rel);
      trackFile(files, `vault/${rel}`, 1, copyHashed(sourceFile, destFile));
    }

    options.onProgress?.("ledger");
    const snapshot = snapshotOf(db);
    writeStream(
      staging,
      "ledger/events.jsonl",
      pageEvents(db, snapshot),
      files,
      options.signal,
    );
    writeStream(staging, "ledger/event_purges.jsonl", pagePurges(db), files, options.signal);
    options.onProgress?.("claims");
    writeStream(staging, "claims/claims.jsonl", pageClaims(db), files, options.signal);
    writeStream(
      staging,
      "claims/supersessions.jsonl",
      pageSupersessions(db),
      files,
      options.signal,
    );
    writeStream(staging, "claims/bindings.jsonl", pageBindings(db), files, options.signal);
    options.onProgress?.("receipts");
    writeStream(staging, "canon/receipts.jsonl", pageReceipts(db), files, options.signal);
    writeStream(
      staging,
      "connections.jsonl",
      pageConnections(db),
      files,
      options.signal,
    );
    writeStream(
      staging,
      "checkpoints.jsonl",
      pageCheckpoints(db),
      files,
      options.signal,
    );

    if ((files["ledger/events.jsonl"]?.count ?? 0) !== snapshot.event_count) {
      throw new Error("export event stream drifted from the snapshot");
    }
    const manifest = signManifest({
      schema: BACKUP_SCHEMA,
      vault_id: readVaultId(source),
      created_at: new Date().toISOString(),
      schema_versions: supportedSchemaVersions(ledgerSchemaVersion(db)),
      snapshot,
      complete: true,
      files: sortedFiles(files),
    });
    writePrivateFile(join(staging, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    verifyFiles(staging, manifest);
    unlinkSync(join(staging, INCOMPLETE));
    fsyncDirectory(staging);
    installStaging(staging, destination);
    fsyncDirectory(parent);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function basenameSafe(path: string): string {
  const name = path.split(sep).pop();
  return name === undefined || name.length === 0 ? "backup" : name;
}

function verifyFiles(root: string, manifest: ExportManifest): void {
  if (manifest.schema !== BACKUP_SCHEMA) {
    throw new Error(`backup schema is not ${BACKUP_SCHEMA}`);
  }
  const expectedHash = signManifest({
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files: manifest.files,
  }).manifest_sha256;
  if (manifest.manifest_sha256 !== expectedHash) {
    throw new Error("backup manifest hash does not match");
  }
  for (const key of Object.keys(manifest.files).sort(compareCodeUnits)) {
    const entry = manifest.files[key];
    if (entry === undefined) continue;
    const path = pathUnder(root, splitBackupPath(key));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      throw new Error(`backup file is missing: ${key}`);
    }
    if (fileMode(path) !== FILE_MODE) {
      throw new Error(`backup file is not owner-only: ${key}`);
    }
    const hashed = hashFile(path);
    if (hashed.sha256 !== entry.sha256 || hashed.size !== entry.size) {
      throw new Error(`backup file hash mismatch: ${key}`);
    }
  }
}

function assertComplete(root: string, manifest: ExportManifest): void {
  if (manifest.complete !== true) {
    throw new Error("backup manifest is not complete");
  }
  if (existsSync(join(root, INCOMPLETE))) {
    throw new Error("backup is marked incomplete");
  }
}

function readTextFile(path: string): string {
  const fd = openSync(path, "r");
  const chunks: Buffer[] = [];
  try {
    const buf = Buffer.alloc(CHUNK);
    let read = readSync(fd, buf);
    while (read > 0) {
      chunks.push(Buffer.from(buf.subarray(0, read)));
      read = readSync(fd, buf);
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readManifest(backupDir: string): ExportManifest {
  const path = join(backupDir, "manifest.json");
  if (!existsSync(path)) throw new Error("backup manifest is missing");
  const manifest = JSON.parse(readTextFile(path)) as ExportManifest;
  if (manifest.schema !== BACKUP_SCHEMA) {
    throw new Error(`backup schema is not ${BACKUP_SCHEMA}`);
  }
  return manifest;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`backup row is not an object in ${path}`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}: must be a string`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field}: must be a number`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}: must be a boolean`);
  return value;
}

function insertEvent(db: Database, raw: Record<string, unknown>): void {
  const validated = validateEventInput({
    schema: "kizuki.event/v1",
    connector_id: asString(raw.connector_id, "connector_id"),
    source_record_id: asString(raw.source_record_id, "source_record_id"),
    kind: asString(raw.kind, "kind"),
    occurred_at: asString(raw.occurred_at, "occurred_at"),
    observed_at: asString(raw.observed_at, "observed_at"),
    text: asString(raw.text, "text"),
    subjects: raw.subjects,
    deleted: asBoolean(raw.deleted, "deleted"),
    attachments: raw.attachments,
    metadata: raw.metadata,
    ...(typeof raw.sensitivity_hint === "string"
      ? { sensitivity_hint: raw.sensitivity_hint }
      : {}),
  });
  if (!validated.ok) {
    throw new Error(`backup event is invalid: ${validated.errors.join("; ")}`);
  }
  const input = validated.value;
  const contentHash = computeContentHash(input);
  if (contentHash !== asString(raw.content_hash, "content_hash")) {
    throw new Error(`backup event content_hash does not match ${raw.event_id}`);
  }
  db.query(
    `INSERT INTO events (
       event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
       text, subjects, sensitivity_hint, deleted, attachments, metadata,
       content_hash, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.event_id, "event_id"),
    input.connector_id,
    input.source_record_id,
    input.kind,
    input.occurred_at,
    input.observed_at,
    input.text,
    JSON.stringify(input.subjects),
    input.sensitivity_hint ?? null,
    input.deleted ? 1 : 0,
    JSON.stringify(input.attachments),
    JSON.stringify(input.metadata),
    contentHash,
    asString(raw.accepted_at, "accepted_at"),
  );
}

function insertPurge(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO event_purges
       (receipt_id, event_id, connector_id, reason, purged_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.receipt_id, "receipt_id"),
    asString(raw.event_id, "event_id"),
    asString(raw.connector_id, "connector_id"),
    asString(raw.reason, "reason"),
    asString(raw.purged_at, "purged_at"),
  );
}

function insertClaimRow(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.claim_id, "claim_id"),
    asString(raw.kind, "kind"),
    asStringOrNull(raw.target, "target"),
    asString(raw.body, "body"),
    JSON.stringify(raw.frontmatter ?? {}),
    JSON.stringify(raw.provenance ?? []),
    JSON.stringify(raw.subjects ?? []),
    asString(raw.producer, "producer"),
    asNumber(raw.confidence, "confidence"),
    asString(raw.status, "status"),
    asString(raw.created_at, "created_at"),
    asString(raw.body_hash, "body_hash"),
    asStringOrNull(raw.subject, "subject"),
    asStringOrNull(raw.predicate, "predicate"),
    asStringOrNull(raw.object, "object"),
    asString(raw.polarity ?? "positive", "polarity"),
    asStringOrNull(raw.claim_key, "claim_key"),
    asString(raw.authority ?? "connector_evidence", "authority"),
    asStringOrNull(raw.sensitivity, "sensitivity"),
    asString(raw.taint ?? "quoted", "taint"),
    asStringOrNull(raw.model_ref, "model_ref"),
    asString(raw.valid_from ?? "", "valid_from"),
    asStringOrNull(raw.valid_to, "valid_to"),
    asString(raw.asserted_at ?? "", "asserted_at"),
    asStringOrNull(raw.retracted_at, "retracted_at"),
    asStringOrNull(raw.superseded_by, "superseded_by"),
    asStringOrNull(raw.receipt_id, "receipt_id"),
    asNumber(raw.corroboration ?? 1, "corroboration"),
    asStringOrNull(raw.last_confirmed_at, "last_confirmed_at"),
  );
}

function insertSupersession(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO claim_supersessions
       (winner, loser, rule, prior_valid_to, receipt_id, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.winner, "winner"),
    asString(raw.loser, "loser"),
    asString(raw.rule, "rule"),
    asStringOrNull(raw.prior_valid_to, "prior_valid_to"),
    asString(raw.receipt_id, "receipt_id"),
    asString(raw.at, "at"),
  );
}

function insertBinding(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO claim_bindings (claim_key, page_id, bound_at) VALUES (?, ?, ?)`,
  ).run(
    asString(raw.claim_key, "claim_key"),
    asString(raw.page_id, "page_id"),
    asString(raw.bound_at, "bound_at"),
  );
}

function insertConnectionRow(db: Database, raw: Record<string, unknown>): void {
  const refs = raw.secret_refs;
  if (!Array.isArray(refs) || !refs.every((item) => typeof item === "string")) {
    throw new Error("connection secret_refs must be a string array");
  }
  if (refs.some((ref) => !ref.startsWith("file:") && !ref.startsWith("env:"))) {
    throw new Error("connection secret_refs must be secret references");
  }
  db.query(
    `INSERT INTO connections
       (connector_id, source_key, config, secret_refs, connected_at, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.connector_id, "connector_id"),
    asString(raw.source_key, "source_key"),
    JSON.stringify(raw.config),
    JSON.stringify(refs),
    asString(raw.connected_at, "connected_at"),
    asStringOrNull(raw.disconnected_at, "disconnected_at"),
  );
}

function insertReceipt(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO canon_receipts
       (receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
        before_hash, after_hash, at, receipt_kind, page_action, archive_path,
        writer, producer, model_ref, authority, confidence, taint,
        candidates, superseded, retrieval_ops, reverts, reverted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.receipt_id, "receipt_id"),
    JSON.stringify(raw.claim_ids ?? []),
    JSON.stringify(raw.provenance ?? []),
    asString(raw.sensitivity, "sensitivity"),
    asString(raw.page_path, "page_path"),
    asString(raw.claim_kind ?? "claim", "claim_kind"),
    asStringOrNull(raw.before_hash, "before_hash"),
    asString(raw.after_hash, "after_hash"),
    asString(raw.at, "at"),
    asString(raw.kind ?? "write", "kind"),
    asString(raw.page_action ?? "edit", "page_action"),
    asStringOrNull(raw.archive_path, "archive_path"),
    asString(raw.writer ?? "import", "writer"),
    asString(raw.producer ?? "deterministic", "producer"),
    asStringOrNull(raw.model_ref, "model_ref"),
    asString(raw.authority ?? "connector_evidence", "authority"),
    asNumber(raw.confidence ?? 1, "confidence"),
    asString(raw.taint ?? "quoted", "taint"),
    JSON.stringify(raw.candidates ?? []),
    JSON.stringify(raw.superseded ?? []),
    JSON.stringify(raw.retrieval_ops ?? []),
    asStringOrNull(raw.reverts, "reverts"),
    asStringOrNull(raw.reverted_by, "reverted_by"),
  );
}

function insertCheckpointRow(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO checkpoints
       (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.connector_id, "connector_id"),
    asString(raw.source_key, "source_key"),
    asStringOrNull(raw.cursor, "cursor"),
    asString(raw.mode, "mode"),
    asString(raw.updated_at, "updated_at"),
    asString(raw.last_run_at, "last_run_at"),
    JSON.stringify(raw.last_result ?? {}),
  );
}

function* streamRows(
  backupDir: string,
  relativePath: string,
  required: boolean,
): Generator<Record<string, unknown>> {
  const path = join(backupDir, relativePath);
  if (!existsSync(path)) {
    if (required) throw new Error(`backup is missing ${relativePath}`);
    return;
  }
  for (const row of readJsonl(path)) {
    refuseSecrets(row, relativePath);
    yield asRecord(row, relativePath);
  }
}

export function verifyBackup(backupDir: string): ExportManifest {
  const root = resolveExisting(backupDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`backup directory is missing: ${backupDir}`);
  }
  const manifest = readManifest(root);
  verifyFiles(root, manifest);
  assertComplete(root, manifest);
  return manifest;
}

export function restoreVault(
  backupDir: string,
  targetDir: string,
  options: ExportOptions = {},
): RestoreReport {
  throwIfAborted(options.signal);
  const source = resolve(backupDir);
  const destination = resolve(targetDir);
  assertSeparated(source, destination);
  const manifest = verifyBackup(source);
  const supported = supportedSchemaVersions();
  if (manifest.schema_versions.ledger > supported.ledger) {
    throw new Error(
      `backup ledger schema ${manifest.schema_versions.ledger} is newer than ${supported.ledger}`,
    );
  }
  prepareDestination(destination);
  const parent = dirname(destination);
  mkdirPrivate(parent);

  const staging = join(
    parent,
    `${basenameSafe(destination)}${STAGING_MARK}${ulid()}.partial`,
  );
  mkdirPrivate(staging);
  writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
  options.onProgress?.("staging");

  try {
    for (const key of Object.keys(manifest.files).sort(compareCodeUnits)) {
      if (!key.startsWith("vault/")) continue;
      throwIfAborted(options.signal);
      options.onProgress?.("vault");
      const parts = splitBackupPath(key);
      if (parts[0] !== "vault") continue;
      copyHashed(pathUnder(source, parts), pathUnder(staging, parts.slice(1)));
    }
    initVault(staging);
    if (manifest.vault_id !== null) {
      const idPath = vaultIdPath(staging);
      if (!existsSync(idPath)) {
        writePrivateFile(idPath, Buffer.from(`${manifest.vault_id}\n`));
      }
    }

    const db = openLedger(join(staging, ".kizuki", "kizuki.db"));
    try {
      options.onProgress?.("ledger");
      db.transaction(() => {
        for (const row of streamRows(source, "ledger/events.jsonl", true)) {
          throwIfAborted(options.signal);
          insertEvent(db, row);
        }
        for (const row of streamRows(source, "ledger/event_purges.jsonl", true)) {
          insertPurge(db, row);
        }
        for (const row of streamRows(source, "claims/claims.jsonl", false)) {
          insertClaimRow(db, row);
        }
        syncCompatProposals(db);
        for (const row of streamRows(source, "claims/supersessions.jsonl", false)) {
          insertSupersession(db, row);
        }
        for (const row of streamRows(source, "claims/bindings.jsonl", false)) {
          insertBinding(db, row);
        }
        for (const row of streamRows(source, "canon/receipts.jsonl", true)) {
          insertReceipt(db, row);
        }
        for (const row of streamRows(source, "connections.jsonl", true)) {
          insertConnectionRow(db, row);
        }
        for (const row of streamRows(source, "checkpoints.jsonl", true)) {
          insertCheckpointRow(db, row);
        }
      })();

      const events =
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
          ?.count ?? 0;
      if (events !== manifest.snapshot.event_count) {
        throw new Error("restored event count does not match the snapshot");
      }
      rebuildDerived(db, staging);
      rebuildPageIndex({ db, vault_path: staging });
      const doctor = doctorVault(staging);
      const report: RestoreReport = {
        vault_id: readVaultId(staging),
        events,
        claims:
          db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM claims").get()
            ?.count ?? 0,
        receipts:
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM canon_receipts",
            )
            .get()?.count ?? 0,
        vault_files: Object.keys(manifest.files).filter((key) =>
          key.startsWith("vault/"),
        ).length,
        doctor: doctor.counts,
      };
      db.close();
      unlinkSync(join(staging, INCOMPLETE));
      fsyncDirectory(staging);
      installStaging(staging, destination);
      fsyncDirectory(parent);
      return report;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
