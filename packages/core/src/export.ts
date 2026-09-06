import { assertVaultMutationScope, withVaultMutationSync, type VaultMutationScope, type VaultMutationTarget } from "./vault/mutation-scope";
import { assertReceiptPaths } from "./canon/paths";
import { isRfc3339 } from "./util/time";
import { sourcePolicyEpoch, inspectSourceGrant, sourceEventsAllowed } from "./ledger/source-grants";
import { Database, constants as SQLITE_CONSTANTS } from "bun:sqlite";
import { openOwnedDirectory, OwnedDirectoryPublicationError, type OwnedDirectory, type OwnedDirectoryIdentity } from "./util/owned-directory";
import {
  type Stats,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
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
import { contentSignature } from "./claims/hash";
import { CLAIMS_SCHEMA_VERSION, syncCompatProposals } from "./claims/schema";
import { canonicalizeProducer, isProducer } from "./contracts/proposal";
import { validateAbsenceProof, validateProvenanceAbsenceProof } from "./contracts/retrieval";
import { isPlainObject } from "./util/validate";
import {
  LEGACY_IDENTITY_EVIDENCE_MAX_BYTES,
  LEGACY_IDENTITY_ENDPOINT_MAX_BYTES,
  LEGACY_IDENTITY_SCAN_MAX_ROWS,
  scanLegacyIdentityRows,
} from "./claims/identity";
import { rebuildDerived } from "./derived";
import { EVENT_LIMITS, type CaptureEvent } from "./contracts/event";
import { isUlid, ulid } from "./util/ulid";
import { writeRailCursor } from "./ledger/checkpoints";
import { NULL_CONNECTION_CONFIG } from "./ledger/connection-state";
import { LEDGER_SCHEMA_VERSION, openLedger } from "./ledger/db";
import {
  LINEAGE_UNAVAILABLE_WARNING,
  MAX_SOURCE_SURVIVOR_LINEAGE_ROW_BYTES,
  MAX_SOURCE_SURVIVOR_LINEAGE_ROWS,
  SOURCE_SURVIVOR_LINEAGE_BACKUP,
  assertSourceSurvivorLineageGraph,
  restoreSourceSurvivorLineageRow,
  sourceSurvivorLineageExportRows,
} from "./ledger/canon-source-survivor-lineage";
import { eventFromRow, parseEventRecord, type LegacyEventRecord } from "./ledger/event-record";
import { bindLegacyEventOrigins, installEventIdentityGuards } from "./ledger/event-identity-schema";
import { readSchemaVersion } from "./ledger/integrity";
import { PURGE_SCHEMA_VERSION } from "./ledger/purge-schema";
import { tableExists } from "./ledger/schema";
import { SENSITIVITY_SCHEMA_VERSION } from "./sensitivity/schema";
import { SERVE_SCHEMA_VERSION } from "./serve/types";
import { extractBatchFilingVersion, validateDurableExtractStorage } from "./serve/extract";
import { readVaultId, vaultIdPath } from "./serve/vault-id";
import { doctorVault } from "./vault/doctor";
import { initVault } from "./vault/init";
import { parseFrontmatter } from "./vault/frontmatter";
import { MAX_CANON_DEPTH, MAX_CANON_PAGE_BYTES, MAX_CANON_PAGES, MAX_CANON_WALK_BYTES } from "./vault/pages";
import { validatePage } from "./vault/schema";

export const BACKUP_SCHEMA = "kizuki.backup/v3" as const;
export const V2_BACKUP_SCHEMA = "kizuki.backup/v2" as const;
export const LEGACY_BACKUP_SCHEMA = "kizuki.backup/v1" as const;
type BackupSchema = typeof BACKUP_SCHEMA | typeof V2_BACKUP_SCHEMA | typeof LEGACY_BACKUP_SCHEMA;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PAGE = 256;
const CHUNK = 65_536;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const STAGING_MARK = ".kizuki-backup-";
const INCOMPLETE = ".kizuki-backup-incomplete";
const CONTROL_DIR = ".kizuki";
const EXTRACT_BATCH_BACKUP = "serve/extract-batches.jsonl";
const RAIL_CURSORS_BACKUP = "rail_cursors.jsonl";
const MACHINE_BYTE_INTENTS_BACKUP = "ledger/canon-machine-byte-intents.jsonl";
const MAX_EXTRACT_BATCH_BACKUP_BYTES = 2_000_000;
const MAX_EVENT_BACKUP_ROW_BYTES = EVENT_LIMITS.eventBytes + 2_048;
const MAX_MACHINE_BYTE_INTENT_ROW_BYTES = 512;
const IDENTITY_BACKUP = "claims/identity_links.jsonl";
// Allow worst-case JSON escaping within the scanner's 1 MiB raw-text budget.
const MAX_IDENTITY_BACKUP_BYTES = 8_388_608;
const MAX_IDENTITY_BACKUP_ROW_BYTES = 131_072;
const SOURCE_INVENTORY_BACKUP = "ledger/source_store_inventory.jsonl";
const EXPORT_INVENTORY = "export-inventory.json";
const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_ERASURE_REPORT_BYTES = 2_000_000;
const MAX_SOURCE_INVENTORY_ROW_BYTES = 6 * MAX_ERASURE_REPORT_BYTES + 1_024;
const PURGE_HISTORY_COLUMNS = {
  purge_batches: ["batch_id", "state", "created_at"],
  purge_batch_receipts: ["receipt_id", "batch_id"],
  purge_ops: ["op_id", "receipt_id", "store", "ids", "state", "proof", "created_at", "done_at"],
} as const;
type PurgeHistoryTable = keyof typeof PURGE_HISTORY_COLUMNS;
const PURGE_HISTORY_TABLES = Object.keys(PURGE_HISTORY_COLUMNS) as PurgeHistoryTable[];
const MAX_PURGE_IDS_BYTES = 16_777_216;
const MAX_PURGE_PROOF_BYTES = 65_536;
// Stored JSON is escaped once more in its enclosing JSONL record.
const MAX_PURGE_OP_ROW_BYTES = 6 * (MAX_PURGE_IDS_BYTES + MAX_PURGE_PROOF_BYTES) + 65_536;
const PURGE_HISTORY_RECOVERY_WARNING = "backup lacks complete historical purge batch membership or store evidence; unassigned receipts remain unverifiable and no membership was inferred";
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
  schema: BackupSchema;
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
  /** Synchronous notifications run outside SQLite transactions while the writer
   * remains owned. Inventory is a pre-copy preview; later phases describe the
   * sealed capture and cannot alter its database cut. */
  onProgress?: (label: string) => void;
}

/** Publication succeeded even though a later transaction/ownership cleanup failed. */
class ExportPublicationError extends Error {
  readonly publication = "published" as const;
  readonly durability = "synced" as const;
  constructor(cause: unknown) {
    super("export was published and synced; subsequent cleanup failed", { cause });
    this.name = "ExportPublicationError";
  }
}

export interface RestoreReport {
  vault_id: string | null;
  events: number;
  claims: number;
  receipts: number;
  vault_files: number;
  doctor: { total: number; valid: number; invalid: number };
  /** Runtime recovery limits, including disconnected portable connection history. */
  recovery_warnings: readonly string[];
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
  content_hash_version: 1 | 2;
  text_hash: string;
  origin: "external" | "self";
  origin_binding_version: 1;
  origin_binding_kind: CaptureEvent["origin_binding_kind"];
  origin_binding: string;
  accepted_at: string;
}

interface MachineByteIntentRow {
  receipt_id: string;
  before_hash: string | null;
  after_hash: string;
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
  content_hash: string;
}

interface ConnectionRow {
  connector_id: string;
  source_key: string;
  connected_at: string;
  disconnected_at: string | null;
  implementation_version: string;
  consent_required: number;
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

interface RailCursorRow {
  rail: string;
  source_key: string;
  cursor: string;
  updated_at: string;
}

interface DeferredInputRow {
  event_id: string;
  source_key: string | null;
  checked_revision: number;
  checked_binding_digest: string;
}

interface ExtractBatchRow {
  previous_cursor: string;
  cursor: string;
  drafts: string;
  model_ref: string | null;
  created_at: string;
  input_ids: string | null;
  integrity: string | null;
  outcome: string;
  batch_mode: string;
  model_inputs: string | null;
  deferred_inputs: string | null;
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

interface SensitivityRow {
  connector_id: string;
  source_key: string;
  default_sensitivity: string;
  floor: string;
  set_by: string;
  at: string;
}

const EVENT_COLUMNS = `
  event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
  text, subjects, sensitivity_hint, deleted, attachments, metadata,
  content_hash, content_hash_version, text_hash, origin, accepted_at,
  origin_binding_version, origin_binding_kind, origin_binding
`;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

const SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const DATABASE_IN_TRANSACTION = Object.getOwnPropertyDescriptor(Database.prototype, "inTransaction")!.get!;
const DATABASE_QUERY = Database.prototype.query;
const DATABASE_FILE_CONTROL = Database.prototype.fileControl;

function throwIfAborted(signal: AbortSignal | undefined): void {
  // Invoke the native brand-checked getter, never a caller-defined accessor.
  if (signal !== undefined && SIGNAL_ABORTED.call(signal) === true) throw new Error("export cancelled");
}

function assertExportTransactionAvailable(db: Database): void {
  if (!(db instanceof Database)) throw new TypeError("export requires an actual SQLite database");
  if (DATABASE_IN_TRANSACTION.call(db) !== false) throw new Error("export requires a top-level SQLite transaction");
}

function nativeMainFilename(db: Database): string {
  const rows = DATABASE_QUERY.call(db, "PRAGMA database_list").all() as { name: string; file: string }[];
  const main = rows.find(row => row.name === "main");
  if (main === undefined || typeof main.file !== "string") throw new Error("export database affinity unavailable");
  return main.file;
}

interface ExportSource {
  readonly control: OwnedDirectory;
  assertCurrent(): void;
  close(): void;
}

/** The file-control query validates SQLite's opened inode, not db.filename. */
function openExportSource(db: Database, vaultPath: string): ExportSource {
  assertExportTransactionAvailable(db);
  const mainFile = nativeMainFilename(db);
  const expected = join(vaultPath, ".kizuki", "kizuki.db");
  if (mainFile !== "" && resolveExisting(mainFile) !== resolveExisting(expected)) {
    throw new Error("export database does not belong to the selected vault");
  }
  let root: OwnedDirectory | undefined;
  let control: OwnedDirectory | undefined;
  let ledgerFd: number | null = null;
  try {
    root = openOwnedDirectory(vaultPath);
    control = openOwnedDirectory(join(vaultPath, ".kizuki"));
    let ledgerIdentity: { dev: number; ino: number } | null = null;
    if (mainFile !== "") {
      ledgerFd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = requireSingleLinkRegularFile(ledgerFd);
      if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) throw new Error("export database identity unavailable");
      ledgerIdentity = { dev: stat.dev, ino: stat.ino };
    }
    const capturedRoot = root, capturedControl = control, capturedFd = ledgerFd;
    let closed = false;
    const source: ExportSource = {
      control: capturedControl,
      assertCurrent() {
        capturedRoot.assertCurrent(); capturedControl.assertCurrent();
        if (nativeMainFilename(db) !== mainFile) throw new Error("export database affinity changed");
        // Engine-confirmed unnamed databases have no physical-file affinity.
        if (capturedFd === null || ledgerIdentity === null) return;
        const opened = requireSingleLinkRegularFile(capturedFd);
        const current = capturedControl.inspect(["kizuki.db"]);
        if (current === null || !current.isFile() || current.nlink !== 1 ||
            opened.dev !== ledgerIdentity.dev || opened.ino !== ledgerIdentity.ino ||
            current.dev !== ledgerIdentity.dev || current.ino !== ledgerIdentity.ino) {
          throw new Error("export database affinity changed");
        }
        const moved = new Int32Array([-1]);
        const result = DATABASE_FILE_CONTROL.call(db, "main", SQLITE_CONSTANTS.SQLITE_FCNTL_HAS_MOVED, moved);
        if (result !== 0 /* SQLITE_OK */ || moved[0] !== 0) throw new Error("export database affinity unavailable or changed");
      },
      close() {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        for (const close of [() => { if (capturedFd !== null) closeSync(capturedFd); },
          () => capturedControl.close(), () => capturedRoot.close()]) {
          try { close(); } catch (error) { errors.push(error); }
        }
        if (errors.length !== 0) throw new AggregateError(errors, "export source descriptor cleanup failed");
      },
    };
    source.assertCurrent();
    return source;
  } catch (error) {
    if (ledgerFd !== null) closeSync(ledgerFd);
    control?.close(); root?.close();
    throw error;
  }
}

function vaultIdentity(source: ExportSource): { value: string | null; bytes: Uint8Array | null } {
  const bytes = source.control.readFile(["vault-id"], MAX_CANON_PAGE_BYTES);
  const text = bytes === null ? "" : Buffer.from(bytes).toString("utf8").split("\n")[0]?.trim() ?? "";
  return { value: text.length === 0 ? null : text, bytes };
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && Buffer.from(left).equals(right);
}

function sqliteSchemaCookie(db: Database): number {
  const row = DATABASE_QUERY.call(db, "PRAGMA main.schema_version").get() as { schema_version: number } | null;
  if (row === null || !Number.isSafeInteger(row.schema_version)) throw new Error("export schema identity unavailable");
  return row.schema_version;
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
  expected?: { sha256: string; size: number },
): { sha256: string; size: number } {
  mkdirPrivate(dirname(destination));
  const hasher = new Bun.CryptoHasher("sha256");
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  let size = 0;
  try {
    requireSingleLinkRegularFile(input);
    output = openSync(destination, "wx", FILE_MODE);
    const buf = Buffer.alloc(CHUNK);
    let read = readSync(input, buf);
    while (read > 0) {
      const slice = buf.subarray(0, read);
      if (expected !== undefined && size + read > expected.size) {
        throw new Error("export inventory file changed before copying completed");
      }
      hasher.update(slice);
      writeAll(output, slice);
      size += read;
      read = readSync(input, buf);
    }
    requireSingleLinkRegularFile(input);
    fsyncSync(output);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
  chmodSync(destination, FILE_MODE);
  const result = { sha256: hasher.digest("hex"), size };
  if (expected !== undefined && (result.sha256 !== expected.sha256 || result.size !== expected.size)) {
    throw new Error("export inventory file changed before copying completed");
  }
  return result;
}

function requireSingleLinkRegularFile(fd: number): Stats {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1) throw new Error("backup file must be regular and singly linked");
  return info;
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

function isControlDir(name: string): boolean {
  return name.toLowerCase() === CONTROL_DIR;
}

interface InventoryFile {
  path: string;
  kind: "doctrine" | "canon" | "archive";
  sha256: string;
  size: number;
}

interface VaultInventory {
  schema: "kizuki.export-inventory/v1";
  files: InventoryFile[];
  excluded_entries: { hidden: number; links_or_special: number; backup_containers: number; unclassified: number };
  unavailable_archive_references: number;
  recovery_limits: readonly string[];
}

/** Classify bounded exact bytes before copying; directory membership alone grants no inclusion. */
function vaultInventory(db: Database, root: string): VaultInventory {
  const inventory: VaultInventory = {
    schema: "kizuki.export-inventory/v1",
    files: [],
    excluded_entries: { hidden: 0, links_or_special: 0, backup_containers: 0, unclassified: 0 },
    unavailable_archive_references: 0,
    recovery_limits: [
      "The v3 streams exclude credentials, opaque connection state and agent enrollment authority.",
      "The v3 streams preserve completed purge batches and store obligations; pending purge work is refused. Other journals, holds and run or audit history are not preserved.",
      ...(hasUnassignedPurgeReceipts(db) ? [PURGE_HISTORY_RECOVERY_WARNING] : []),
      "Selected files and database streams share one SQLite capture and the cooperating writer fence; manual edits and complete runtime recovery remain outside this guarantee.",
      "A complete manifest verifies this artifact's listed bytes; it does not assert complete runtime recovery.",
    ],
  };
  let visited = 0;
  let inspectedBytes = 0;
  let canonCount = 0;
  const ids = new Set<string>();
  const archiveHashes = new Map<string, Set<string>>();
  const legacyHashes = new Map<string, Set<string>>();
  const SHA256 = /^[a-f0-9]{64}$/;
  function remember(index: Map<string, Set<string>>, key: string, hash: string | null): void {
    if (hash === null || !SHA256.test(hash)) return;
    const hashes = index.get(key) ?? new Set<string>();
    hashes.add(hash);
    index.set(key, hashes);
  }
  function ordinaryPath(path: string): boolean {
    const parts = path.split("/");
    return path.length <= 1024 && parts.length <= MAX_CANON_DEPTH &&
      parts.every(part => part.length > 0 && !part.startsWith(".") && !part.includes("\\") && !part.includes("\0"));
  }
  if (tableExists(db, "canon_receipts")) {
    let receipts = 0;
    for (const row of db.query<{
      page_path: string; archive_path: string | null; before_hash: string | null; after_hash: string;
    }, []>("SELECT page_path,archive_path,before_hash,after_hash FROM canon_receipts ORDER BY receipt_id").iterate()) {
      if (++receipts > MAX_INVENTORY_ENTRIES) throw new Error("export receipt inventory exceeds its bound");
      // Source erasure keeps inert receipt history after clearing its file references.
      if (row.page_path === "" && row.archive_path === null) continue;
      if (!ordinaryPath(row.page_path)) throw new Error("export receipt names an unsupported page path");
      if (row.archive_path !== null) {
        if (!ordinaryPath(row.archive_path) || !row.archive_path.startsWith("archive/")) {
          throw new Error("export receipt names an unsupported archive path");
        }
        // Keep an explicit reference even when a historical row has no usable hash.
        if (!archiveHashes.has(row.archive_path)) archiveHashes.set(row.archive_path, new Set());
        remember(archiveHashes, row.archive_path, row.before_hash);
      }
      if (row.page_path.startsWith("archive/")) {
        remember(archiveHashes, row.page_path, row.after_hash);
      } else {
        const base = row.page_path.split("/").at(-1)!.replace(/\.md$/, "");
        for (const prefix of [`${row.page_path.replaceAll("/", "__")}--`, `${base}.prev-`]) {
          remember(legacyHashes, prefix, row.before_hash);
          remember(legacyHashes, prefix, row.after_hash);
        }
      }
    }
  }
  function readBounded(path: string): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = requireSingleLinkRegularFile(fd);
      if (info.size > MAX_CANON_PAGE_BYTES) throw new Error("export inventory file exceeds its bound");
      inspectedBytes += info.size;
      if (inspectedBytes > MAX_CANON_WALK_BYTES) throw new Error("export inventory byte budget exceeded");
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (read === 0) throw new Error("export inventory file changed while reading");
        offset += read;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error("export inventory file changed while reading");
      requireSingleLinkRegularFile(fd);
      return bytes;
    } finally { closeSync(fd); }
  }
  function classify(path: string, rel: string, archive: boolean): void {
    const name = rel.split("/").at(-1)!;
    const doctrine = rel === "CANON.md" || rel === "SCHEMA.md";
    if (!doctrine && !name.endsWith(".md")) {
      inventory.excluded_entries.unclassified++;
      return;
    }
    const explicitHashes = archiveHashes.get(rel);
    const matchingHashes = archive ? new Set(explicitHashes) : new Set<string>();
    if (archive) {
      for (const separator of ["--", ".prev-"]) {
        const position = name.lastIndexOf(separator);
        if (position < 0) continue;
        const hashes = legacyHashes.get(name.slice(0, position + separator.length));
        if (hashes !== undefined) for (const hash of hashes) matchingHashes.add(hash);
      }
      if (explicitHashes === undefined && matchingHashes.size === 0) {
        inventory.excluded_entries.unclassified++;
        return;
      }
    }
    const bytes = readBounded(path);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (archive && !matchingHashes.has(sha256)) {
      inventory.excluded_entries.unclassified++;
      return;
    }
    if (!doctrine) {
      const text = FATAL_UTF8.decode(bytes);
      if (!archive && !text.startsWith("---\n") && !text.startsWith("---\r\n")) {
        inventory.excluded_entries.unclassified++;
        return;
      }
      const parsed = parseFrontmatter(text);
      const errors = validatePage(parsed.data);
      if (errors.length > 0) {
        if (archive || Object.hasOwn(parsed.data, "id")) throw new Error("export canon inventory is incomplete: invalid page");
        inventory.excluded_entries.unclassified++;
        return;
      }
      if (!archive) {
        const id = String(parsed.data["id"]);
        if (ids.has(id)) throw new Error("export canon inventory is incomplete: duplicate page identity");
        ids.add(id);
        if (++canonCount > MAX_CANON_PAGES) throw new Error("export canon inventory exceeds its page bound");
      }
    }
    inventory.files.push({ path: rel, kind: doctrine ? "doctrine" : archive ? "archive" : "canon", sha256, size: bytes.length });
  }
  function walk(directory: string, depth: number, archive = false): void {
    if (depth > MAX_CANON_DEPTH) throw new Error("export inventory depth exceeds its bound");
    const handle = opendirSync(directory);
    const entries = [];
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++visited > MAX_INVENTORY_ENTRIES) throw new Error("export inventory entry budget exceeded");
        entries.push(entry);
      }
    } finally { handle.closeSync(); }
    if (depth > 0 && entries.some(entry => entry.name === INCOMPLETE)) {
      inventory.excluded_entries.backup_containers++;
      return;
    }
    const manifest = entries.find(entry => entry.name === "manifest.json" && entry.isFile());
    if (manifest !== undefined && depth > 0) {
      let value: unknown;
      try { value = JSON.parse(FATAL_UTF8.decode(readBounded(join(directory, manifest.name)))); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (isPlainObject(value) && typeof value["schema"] === "string" && value["schema"].startsWith("kizuki.backup/")) {
        inventory.excluded_entries.backup_containers++;
        return;
      }
    }
    for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (entry.name.startsWith(".")) { inventory.excluded_entries.hidden++; continue; }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        inventory.excluded_entries.links_or_special++;
        continue;
      }
      const path = join(directory, entry.name);
      const rel = posixRel(root, path);
      if (entry.isDirectory()) walk(path, depth + 1, archive || rel === "archive");
      else {
        if (depth + 1 > MAX_CANON_DEPTH) throw new Error("export inventory depth exceeds its bound");
        classify(path, rel, archive);
      }
    }
  }
  walk(root, 0);
  const doctrine = inventory.files.filter(file => file.kind === "doctrine");
  if (doctrine.length !== 2 || !["CANON.md", "SCHEMA.md"].every(path => doctrine.some(file => file.path === path))) {
    throw new Error("export inventory requires regular root doctrine files CANON.md and SCHEMA.md");
  }
  inventory.files.sort((a, b) => compareCodeUnits(a.path, b.path));
  const selected = new Set(inventory.files.map(file => file.path));
  inventory.unavailable_archive_references = [...archiveHashes.keys()].filter(path => !selected.has(path)).length;
  return inventory;
}

function ledgerSchemaVersion(db: Database): number {
  return readSchemaVersion(db);
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
    content_hash_version: row.content_hash_version,
    text_hash: row.text_hash,
    origin: row.origin,
    origin_binding_version: row.origin_binding_version,
    origin_binding_kind: row.origin_binding_kind,
    origin_binding: row.origin_binding,
    accepted_at: row.accepted_at,
  };
}

function backupEventRecord(
  raw: Record<string, unknown>,
  format: "legacy" | "current",
): { event: CaptureEvent | LegacyEventRecord; accepted_at: string } {
  const { accepted_at, ...record } = raw;
  if (typeof accepted_at !== "string" || accepted_at.length > EVENT_LIMITS.timestampBytes || !isRfc3339(accepted_at)) {
    throw new Error("backup event accepted_at is invalid");
  }
  return { event: parseEventRecord(record, format), accepted_at };
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
    content_hash: row.content_hash,
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

function* pageMachineByteIntents(db: Database): Generator<MachineByteIntentRow> {
  let after = "";
  while (true) {
    const rows = db
      .query<MachineByteIntentRow, [string, number]>(
        `SELECT receipt_id, before_hash, after_hash
         FROM canon_machine_byte_intents
         WHERE receipt_id > ?
         ORDER BY receipt_id
         LIMIT ?`,
      )
      .all(after, PAGE);
    if (rows.length === 0) return;
    yield* rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.receipt_id;
  }
}

function validateExportEventOrigins(db: Database, snapshot: BackupSnapshot): void {
  if (snapshot.last_event_id === null || snapshot.last_accepted_at === null) return;
  const capAt = snapshot.last_accepted_at;
  const capId = snapshot.last_event_id;
  let cursor: { accepted_at: string; event_id: string } | null = null;
  while (true) {
    const rows: EventRow[] = cursor === null
      ? db.query<EventRow, [string, string, string, number]>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE accepted_at < ? OR (accepted_at = ? AND event_id <= ?)
           ORDER BY accepted_at, event_id LIMIT ?`,
        ).all(capAt, capAt, capId, PAGE)
      : db.query<EventRow, [string, string, string, string, string, string, number]>(
          `SELECT ${EVENT_COLUMNS} FROM events
           WHERE (accepted_at > ? OR (accepted_at = ? AND event_id > ?))
             AND (accepted_at < ? OR (accepted_at = ? AND event_id <= ?))
           ORDER BY accepted_at, event_id LIMIT ?`,
        ).all(cursor.accepted_at, cursor.accepted_at, cursor.event_id, capAt, capAt, capId, PAGE);
    if (rows.length === 0) return;
    for (const row of rows) {
      eventFromRow(row, db);
    }
    if (rows.length < PAGE) return;
    const last: EventRow = rows.at(-1)!;
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

function* pageIdentityLinks(db: Database): Generator<Record<string, unknown>> {
  for (const row of scanLegacyIdentityRows(db)) {
    yield {
      ...row,
      // V3 preserves the exact opaque text; parsing it grants no authority.
      evidence: { encoding: "kizuki.identity-evidence/raw-v1", raw: row.evidence },
    };
  }
}

function* pageConnectorSensitivity(db: Database): Generator<SensitivityRow> {
  if (!tableExists(db, "connector_sensitivity")) return;
  let after: { connector_id: string; source_key: string } | null = null;
  while (true) {
    let rows: SensitivityRow[];
    if (after === null) {
      rows = db
        .query<SensitivityRow, [number]>(
          `SELECT connector_id, source_key, default_sensitivity, floor, set_by, at
           FROM connector_sensitivity ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<SensitivityRow, [string, string, string, number]>(
          `SELECT connector_id, source_key, default_sensitivity, floor, set_by, at
           FROM connector_sensitivity
           WHERE connector_id > ?
              OR (connector_id = ? AND source_key > ?)
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(after.connector_id, after.connector_id, after.source_key, PAGE);
    }
    if (rows.length === 0) break;
    yield* rows;
    const last: SensitivityRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    after = { connector_id: last.connector_id, source_key: last.source_key };
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

const CONNECTION_RECOVERY_WARNING = "restored connection history is disconnected and has no connector state; further capture requires supported fresh enrollment with a new source key and fresh consent; retained checkpoints will not resume automatically";

function* pageConnections(db: Database): Generator<Record<string, unknown>> {
  const disconnectedAt = new Date().toISOString();
  let after: { connector_id: string; source_key: string } | null = null;
  while (true) {
    let rows: ConnectionRow[];
    if (after === null) {
      rows = db
        .query<ConnectionRow, [number]>(
          `SELECT connector_id, source_key, connected_at, disconnected_at,
                  implementation_version, consent_required
           FROM connections
           ORDER BY connector_id, source_key LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<ConnectionRow, [string, string, string, number]>(
          `SELECT connector_id, source_key, connected_at, disconnected_at,
                  implementation_version, consent_required
           FROM connections
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
        config: JSON.parse(NULL_CONNECTION_CONFIG) as unknown,
        secret_refs: [],
        connected_at: row.connected_at,
        disconnected_at: row.disconnected_at ?? disconnectedAt,
        implementation_version: row.implementation_version,
        consent_required: row.consent_required,
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

function* pageRailCursors(db: Database): Generator<RailCursorRow> {
  let after: { rail: string; source_key: string } | null = null;
  while (true) {
    let rows: RailCursorRow[];
    if (after === null) {
      rows = db
        .query<RailCursorRow, [number]>(
          `SELECT rail, source_key, cursor, updated_at FROM rail_cursors
           ORDER BY rail, source_key LIMIT ?`,
        )
        .all(PAGE);
    } else {
      rows = db
        .query<RailCursorRow, [string, string, string, number]>(
          `SELECT rail, source_key, cursor, updated_at FROM rail_cursors
           WHERE rail > ?
              OR (rail = ? AND source_key > ?)
           ORDER BY rail, source_key LIMIT ?`,
        )
        .all(after.rail, after.rail, after.source_key, PAGE);
    }
    if (rows.length === 0) break;
    yield* rows;
    const last: RailCursorRow | undefined = rows.at(-1);
    if (last === undefined || rows.length < PAGE) break;
    after = { rail: last.rail, source_key: last.source_key };
  }
}

function* pageDeferredInputs(db: Database): Generator<DeferredInputRow> {
  if (!tableExists(db, "extract_deferred_inputs")) return;
  let after = "";
  while (true) {
    const rows = db.query<DeferredInputRow, [string, number]>(
      `SELECT event_id,source_key,checked_revision,checked_binding_digest
         FROM extract_deferred_inputs WHERE event_id>? ORDER BY event_id LIMIT ?`,
    ).all(after, PAGE);
    if (rows.length === 0) return;
    yield* rows;
    if (rows.length < PAGE) return;
    after = rows.at(-1)!.event_id;
  }
}

function* pendingExtractBatch(db: Database): Generator<ExtractBatchRow> {
  validateDurableExtractStorage(db);
  const rows = db.query<ExtractBatchRow, []>(`SELECT previous_cursor,cursor,drafts,model_ref,created_at,input_ids,integrity,outcome,batch_mode,model_inputs,deferred_inputs
    FROM extract_batches ORDER BY created_at,previous_cursor LIMIT 2`).all();
  if (rows.length > 1) throw new Error("durable extraction batch is corrupt");
  for (const row of rows) {
    extractBatchValues({ ...row });
    yield row;
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

function* readJsonl(path: string, maxRowBytes = Infinity): Generator<unknown> {
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
        if (line.byteLength > maxRowBytes) throw new Error("backup record exceeds its byte bound");
        if (line.byteLength > 0) yield JSON.parse(FATAL_UTF8.decode(line));
        newline = leftover.indexOf(0x0a);
      }
      if (leftover.byteLength > maxRowBytes) throw new Error("backup record exceeds its byte bound");
      read = readSync(fd, buf);
    }
    if (leftover.byteLength > 0) yield JSON.parse(FATAL_UTF8.decode(leftover));
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
  assertExportTransactionAvailable(db);
  const target = Object.freeze({ db, vault_path: resolve(vaultPath) });
  const destination = resolve(outDir);
  const { signal, onProgress } = options;
  if (onProgress !== undefined && typeof onProgress !== "function") throw new TypeError("export progress listener must be a function");
  const captured = Object.freeze({ ...(signal === undefined ? {} : { signal }), ...(onProgress === undefined ? {} : { onProgress }) });
  throwIfAborted(signal);
  assertExportTransactionAvailable(db);
  // Preserve early recovery refusals before callbacks, path access or staging.
  // Authoritative admission is repeated inside both owned transactions below.
  assertSourceExport(db); assertNoPendingPurgeExport(db);
  assertSeparated(target.vault_path, destination);
  const source = openExportSource(db, target.vault_path);
  const publication: { synced: boolean; error: OwnedDirectoryPublicationError | null } = { synced: false, error: null };
  let result: ExportManifest | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = withVaultMutationSync(target, scope => {
      try { return exportVaultOwned(scope, target, destination, captured, source, publication); }
      finally { source.close(); }
    });
  } catch (error) { failed = true; failure = error; }
  try { source.close(); }
  catch (error) { failure = failed ? new AggregateError([failure, error], "export ownership cleanup failed") : error; failed = true; }
  if (failed) {
    if (publication.synced) throw new ExportPublicationError(failure);
    if (publication.error !== null && failure !== publication.error) {
      const prior = publication.error;
      const error = new OwnedDirectoryPublicationError(prior.reason, {
        publication: prior.publication, durability: prior.durability, cleanup_safe: false, parked: prior.parked,
      });
      Object.defineProperty(error, "cause", { value: new AggregateError([prior, failure], "export ownership cleanup failed") });
      throw error;
    }
    throw failure;
  }
  return result!;
}

function exportVaultOwned(
  scope: VaultMutationScope,
  target: VaultMutationTarget & { readonly db: Database },
  destination: string,
  options: Readonly<ExportOptions>,
  source: ExportSource,
  publication: { synced: boolean; error: OwnedDirectoryPublicationError | null },
): ExportManifest {
  assertVaultMutationScope(scope, target);
  const { db, vault_path: vaultPath } = target;
  assertExportTransactionAvailable(db);
  source.assertCurrent();
  throwIfAborted(options.signal);
  prepareDestination(destination);
  const parent = dirname(destination);
  mkdirPrivate(parent);
  const directory = openOwnedDirectory(parent);
  const destinationName = basenameSafe(destination);
  const stagingName = `${destinationName}${STAGING_MARK}${ulid()}.partial`;
  const staging = join(parent, stagingName);
  let stagingIdentity: OwnedDirectoryIdentity | undefined;
  let staged: OwnedDirectory | undefined;
  let published = false;
  let publicationUncertain = false;
  try {
    const destinationIdentity = directory.childIdentity(destinationName);
    stagingIdentity = directory.createStaging(stagingName);
    staged = openOwnedDirectory(staging);
    writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
    const marker = staged.inspect([INCOMPLETE]);
    if (marker === null || !Number.isSafeInteger(marker.dev) || !Number.isSafeInteger(marker.ino)) throw new Error("export staging identity unavailable");
    const markerIdentity = { dev: BigInt(marker.dev), ino: BigInt(marker.ino) };

    const notify = (label: string): void => {
      assertExportTransactionAvailable(db);
      options.onProgress?.(label);
      // A listener may leave a transaction open; never inherit it as a savepoint.
      assertExportTransactionAvailable(db);
      throwIfAborted(options.signal);
      source.assertCurrent(); staged!.assertCurrent(); directory.assertCurrent();
    };
    notify("staging");
    let preview: { bytes: Buffer; epoch: number } | undefined;
    if (options.onProgress !== undefined) {
      assertExportTransactionAvailable(db);
      preview = db.transaction(() => {
        source.assertCurrent(); assertSourceExport(db); assertNoPendingPurgeExport(db);
        return { bytes: Buffer.from(`${JSON.stringify(vaultInventory(db, vaultPath), null, 2)}\n`), epoch: sourcePolicyEpoch(db) };
      }).immediate();
      writePrivateFile(join(staging, EXPORT_INVENTORY), preview.bytes);
      notify("inventory");
    }

    assertExportTransactionAvailable(db);
    const capture = db.transaction(() => {
      source.assertCurrent(); staged!.assertCurrent();
      throwIfAborted(options.signal);
      assertSourceExport(db); assertNoPendingPurgeExport(db);
      const sourceEpoch = sourcePolicyEpoch(db);
      if (preview !== undefined && preview.epoch !== sourceEpoch) throw new Error("source authorization changed during export");
      const identity = vaultIdentity(source);
      const schema = supportedSchemaVersions(ledgerSchemaVersion(db));
      const schemaCookie = sqliteSchemaCookie(db);
      const inventory = vaultInventory(db, vaultPath);
      const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
      if (preview !== undefined && !preview.bytes.equals(inventoryBytes)) throw new Error("export inventory file changed before capture");
      const files: Record<string, ExportManifestEntry> = {};
      if (preview === undefined) writePrivateFile(join(staging, EXPORT_INVENTORY), inventoryBytes);
      trackFile(files, EXPORT_INVENTORY, 1, hashFile(join(staging, EXPORT_INVENTORY)));
      for (const entry of inventory.files) {
        throwIfAborted(options.signal);
        const destFile = join(staging, "vault", entry.path);
        trackFile(files, `vault/${entry.path}`, 1, copyHashed(join(vaultPath, entry.path), destFile, entry));
      }
      const snapshot = snapshotOf(db);
      validateExportEventOrigins(db, snapshot);
      writeStream(
        staging,
        "ledger/events.jsonl",
        pageEvents(db, snapshot),
        files,
        options.signal,
      );
      writeStream(staging, "ledger/event_purges.jsonl", pagePurges(db), files, options.signal);
      for (const table of SOURCE_BACKUP_TABLES) writeStream(staging, `ledger/${table}.jsonl`, sourcePolicyRows(db, table), files, options.signal);
      for (const table of PURGE_HISTORY_TABLES) writeStream(staging, `ledger/${table}.jsonl`, purgeHistoryRows(db, table), files, options.signal);
      writeStream(staging, "claims/claims.jsonl", pageClaims(db), files, options.signal);
      writeStream(
        staging,
        "claims/supersessions.jsonl",
        pageSupersessions(db),
        files,
        options.signal,
      );
      writeStream(staging, "claims/bindings.jsonl", pageBindings(db), files, options.signal);
      writeStream(
        staging,
        "claims/identity_links.jsonl",
        pageIdentityLinks(db),
        files,
        options.signal,
      );
      writeStream(
        staging,
        "ledger/connector_sensitivity.jsonl",
        pageConnectorSensitivity(db),
        files,
        options.signal,
      );
      writeStream(staging, "canon/receipts.jsonl", pageReceipts(db), files, options.signal);
      if (schema.ledger >= 20) {
        writeStream(staging, SOURCE_SURVIVOR_LINEAGE_BACKUP, sourceSurvivorLineageExportRows(db), files, options.signal);
      }
      writeStream(
        staging,
        MACHINE_BYTE_INTENTS_BACKUP,
        pageMachineByteIntents(db),
        files,
        options.signal,
      );
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
      writeStream(staging, RAIL_CURSORS_BACKUP, pageRailCursors(db), files, options.signal);
      writeStream(staging, "serve/extract-deferred-inputs.jsonl", pageDeferredInputs(db), files, options.signal);
      writeStream(staging, EXTRACT_BATCH_BACKUP, pendingExtractBatch(db), files, options.signal);

      if ((files["ledger/events.jsonl"]?.count ?? 0) !== snapshot.event_count) {
        throw new Error("export event stream drifted from the snapshot");
      }
      source.assertCurrent();
      assertSourceExport(db); assertNoPendingPurgeExport(db);
      if (sourcePolicyEpoch(db) !== sourceEpoch) throw new Error("source authorization changed during export");
      const manifest = signManifest({
        schema: BACKUP_SCHEMA, vault_id: identity.value, created_at: new Date().toISOString(),
        schema_versions: schema, snapshot, complete: true, files: sortedFiles(files),
      });
      return { manifest, sourceEpoch, identity, schemaCookie, vaultFiles: inventory.files.length };
    }).immediate();
    const manifest = capture.manifest;
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writePrivateFile(join(staging, "manifest.json"), manifestContent);
    // Bound progress bookkeeping by a count, rather than retaining a label per file.
    for (let file = 0; file < capture.vaultFiles; file += 1) notify("vault");
    for (const phase of ["ledger", "claims", "receipts"]) notify(phase);

    assertExportTransactionAvailable(db);
    return db.transaction(() => {
      staged!.assertCurrent(); directory.assertCurrent();
      verifyFiles(staging, manifest);
      const stagedManifest = readFileSyncNoFollow(join(staging, "manifest.json"), manifestContent.length);
      if (!manifestContent.equals(stagedManifest)) throw new Error("export staged manifest changed");
      throwIfAborted(options.signal);
      source.assertCurrent();
      assertSourceExport(db); assertNoPendingPurgeExport(db);
      if (sourcePolicyEpoch(db) !== capture.sourceEpoch) throw new Error("source authorization changed during export");
      if (ledgerSchemaVersion(db) !== manifest.schema_versions.ledger || sqliteSchemaCookie(db) !== capture.schemaCookie) throw new Error("export schema identity changed");
      if (!sameBytes(vaultIdentity(source).bytes, capture.identity.bytes)) throw new Error("export vault identity changed");
      prepareDestination(destination);
      staged!.removeTree(INCOMPLETE, markerIdentity);
      // No callback separates the fresh admission/identity checks and publication.
      try {
        directory.publishStaging(stagingName, stagingIdentity!, destinationName, destinationIdentity);
        published = true;
        publication.synced = true;
      } catch (error) {
        if (error instanceof OwnedDirectoryPublicationError) {
          published = error.publication === "published";
          publicationUncertain = !error.cleanup_safe;
        } else publicationUncertain = true;
        throw error;
      }
      return manifest;
    }).immediate();
  } catch (error) {
    if (error instanceof OwnedDirectoryPublicationError) publication.error = error;
    if (!published && !publicationUncertain && stagingIdentity !== undefined) {
      try { directory.removeTree(stagingName, stagingIdentity); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "export failed; owned staging cleanup is incomplete"); }
    }
    throw error;
  } finally { staged?.close(); directory.close(); }
}

function readFileSyncNoFollow(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = requireSingleLinkRegularFile(fd);
    if (info.size !== maxBytes || (info.mode & 0o777) !== FILE_MODE) throw new Error("export staged manifest changed");
    const bytes = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("export staged manifest changed");
      offset += count;
    }
    const after = requireSingleLinkRegularFile(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("export staged manifest changed");
    return bytes;
  } finally { closeSync(fd); }
}

function basenameSafe(path: string): string {
  const name = path.split(sep).pop();
  return name === undefined || name.length === 0 ? "backup" : name;
}

function verifyFiles(root: string, manifest: ExportManifest): void {
  assertBackupFormat(manifest);
  hasPurgeHistory(manifest);
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
  if (manifest.schema_versions.serve >= 8) {
    if (manifest.files["serve/extract-deferred-inputs.jsonl"] === undefined) {
      throw new Error("backup deferred extraction stream is missing");
    }
    const batches = manifest.files[EXTRACT_BATCH_BACKUP];
    if (batches === undefined) throw new Error("backup durable extraction stream is missing");
    if (!Number.isSafeInteger(batches.count) || batches.count < 0 || batches.count > 1 ||
        !Number.isSafeInteger(batches.size) || batches.size < 0 || batches.size > MAX_EXTRACT_BATCH_BACKUP_BYTES) {
      throw new Error("backup durable extraction stream exceeds its bound");
    }
  }
  const identities = manifest.files[IDENTITY_BACKUP];
  if (manifest.schema === BACKUP_SCHEMA && identities === undefined) {
    throw new Error("backup legacy identity stream is missing");
  }
  if (identities !== undefined &&
      (!Number.isSafeInteger(identities.count) || identities.count < 0 || identities.count > LEGACY_IDENTITY_SCAN_MAX_ROWS ||
       !Number.isSafeInteger(identities.size) || identities.size < 0 || identities.size > MAX_IDENTITY_BACKUP_BYTES)) {
    throw new Error("backup legacy identity stream exceeds its bound");
  }
  const intents = manifest.files[MACHINE_BYTE_INTENTS_BACKUP];
  if (manifest.schema !== LEGACY_BACKUP_SCHEMA && intents === undefined) {
    throw new Error("backup machine-byte intent stream is missing");
  }
  if (manifest.schema === LEGACY_BACKUP_SCHEMA && intents !== undefined) {
    throw new Error("legacy backup must not include machine-byte intents");
  }
  if (manifest.schema !== LEGACY_BACKUP_SCHEMA && manifest.schema_versions.ledger >= 17 &&
      manifest.files[RAIL_CURSORS_BACKUP] === undefined) {
    throw new Error("backup extract rail cursor stream is missing");
  }
  const lineage = manifest.files[SOURCE_SURVIVOR_LINEAGE_BACKUP];
  if (manifest.schema !== BACKUP_SCHEMA && lineage !== undefined) {
    throw new Error("legacy backup must not include source-survivor lineage");
  }
  if (manifest.schema === BACKUP_SCHEMA && manifest.schema_versions.ledger >= 20) {
    if (lineage === undefined) throw new Error("backup source-survivor lineage stream is missing");
    if (!Number.isSafeInteger(lineage.count) || lineage.count < 0 || lineage.count > MAX_SOURCE_SURVIVOR_LINEAGE_ROWS ||
        !Number.isSafeInteger(lineage.size) || lineage.size < 0) {
      throw new Error("backup source-survivor lineage stream exceeds its bound");
    }
  }
  if (manifest.schema === BACKUP_SCHEMA && manifest.schema_versions.ledger < 20 && lineage !== undefined) {
    throw new Error("backup source-survivor lineage stream is incompatible with this ledger version");
  }
  for (const key of Object.keys(manifest.files).sort(compareCodeUnits)) {
    const entry = manifest.files[key];
    if (entry === undefined) continue;
    const parts = splitBackupPath(key);
    if (parts[0] === "vault" && parts.some(isControlDir)) {
      throw new Error(`backup must not include the control directory: ${key}`);
    }
    const path = pathUnder(root, parts);
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
  assertBackupFormat(manifest);
  return manifest;
}

function assertBackupFormat(manifest: ExportManifest): void {
  if (manifest.schema !== BACKUP_SCHEMA && manifest.schema !== V2_BACKUP_SCHEMA && manifest.schema !== LEGACY_BACKUP_SCHEMA) {
    throw new Error("backup schema is unsupported");
  }
  const versions = manifest.schema_versions;
  if (typeof versions !== "object" || versions === null || !Number.isSafeInteger(versions.ledger)) {
    throw new Error("backup schema versions are invalid");
  }
  // Ledger17 adds explicit rail cursors; ledger16 keeps them in checkpoints.
  // Ledger18 adds local enrollment custody. Ledger19 adds purge batches;
  // their completed history is optional in older v3 backups. Pending work is refused.
  // Ledger20 adds source-survivor lineage. Future migrations must make their
  // own explicit compatibility decision.
  if ((manifest.schema === BACKUP_SCHEMA || manifest.schema === V2_BACKUP_SCHEMA) &&
      versions.ledger !== 16 && versions.ledger !== 17 && versions.ledger !== 18 &&
      versions.ledger !== 19 && versions.ledger !== 20) {
    throw new Error("current backup ledger schema is invalid");
  }
  if (manifest.schema === LEGACY_BACKUP_SCHEMA && (versions.ledger < 1 || versions.ledger > 15)) {
    throw new Error("legacy backup ledger schema is invalid");
  }
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

function insertEvent(
  db: Database,
  raw: Record<string, unknown>,
  format: "legacy" | "current",
): void {
  const { event, accepted_at } = backupEventRecord(raw, format);
  db.query(
    `INSERT INTO events (
       event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
       text, subjects, sensitivity_hint, deleted, attachments, metadata,
       content_hash, content_hash_version, text_hash, origin, accepted_at,
       origin_binding_version, origin_binding_kind, origin_binding
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_id,
    event.connector_id,
    event.source_record_id,
    event.kind,
    event.occurred_at,
    event.observed_at,
    event.text,
    JSON.stringify(event.subjects),
    event.sensitivity_hint ?? null,
    event.deleted ? 1 : 0,
    JSON.stringify(event.attachments),
    JSON.stringify(event.metadata),
    event.content_hash,
    event.content_hash_version,
    event.text_hash,
    event.origin,
    accepted_at,
    "origin_binding_version" in event ? event.origin_binding_version : 0,
    "origin_binding_kind" in event ? event.origin_binding_kind : "",
    "origin_binding" in event ? event.origin_binding : "",
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

const CLAIM_CONTENT_HASH = /^[0-9a-f]{64}$/;

function restoreClaimContentHash(raw: Record<string, unknown>): string {
  const recorded = raw.content_hash;
  if (typeof recorded === "string" && CLAIM_CONTENT_HASH.test(recorded)) {
    return recorded;
  }
  const producer = asString(raw.producer, "producer");
  return contentSignature({
    kind: asString(raw.kind, "kind"),
    target: asStringOrNull(raw.target, "target"),
    body: asString(raw.body, "body"),
    frontmatter: isPlainObject(raw.frontmatter) ? raw.frontmatter : {},
    subjects:
      Array.isArray(raw.subjects) && raw.subjects.every((item) => typeof item === "string")
        ? raw.subjects
        : [],
    producer: isProducer(producer) ? canonicalizeProducer(producer) : producer,
    confidence: asNumber(raw.confidence, "confidence"),
  });
}

function insertClaimRow(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at,
        content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    restoreClaimContentHash(raw),
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

function identityText(value: unknown, maxBytes: number, field: string): string {
  if (typeof value !== "string" || value.length > maxBytes || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`legacy identity ${field} is malformed or oversized`);
  }
  // Bound before allocation. SQLite cannot preserve lone UTF-16 surrogates.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`legacy identity ${field} encoding is malformed`);
  }
  return value;
}

function insertIdentityLink(db: Database, raw: Record<string, unknown>, schema: BackupSchema): void {
  let evidence: string;
  if (schema === BACKUP_SCHEMA) {
    const tagged = typeof raw.evidence === "object" && raw.evidence !== null && !Array.isArray(raw.evidence)
      ? raw.evidence as Record<string, unknown> : null;
    if (tagged === null || Object.keys(tagged).sort().join(",") !== "encoding,raw" ||
        tagged.encoding !== "kizuki.identity-evidence/raw-v1") {
      throw new Error("legacy identity evidence is invalid");
    }
    evidence = identityText(tagged.raw, LEGACY_IDENTITY_EVIDENCE_MAX_BYTES, "evidence");
  } else {
    // Preserve the supported V1/V2 reader's original JSON-value semantics,
    // including its null/missing default. A wire string stays a JSON string.
    evidence = identityText(JSON.stringify(raw.evidence ?? []), LEGACY_IDENTITY_EVIDENCE_MAX_BYTES, "evidence");
  }
  db.query(
    `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identityText(raw.subject_a, LEGACY_IDENTITY_ENDPOINT_MAX_BYTES, "subject_a"),
    identityText(raw.subject_b, LEGACY_IDENTITY_ENDPOINT_MAX_BYTES, "subject_b"),
    asNumber(raw.score, "score"),
    evidence,
    identityText(raw.status, 32, "status"),
    identityText(raw.decided_by, 1024, "decided_by"),
    raw.receipt_id === null || raw.receipt_id === undefined ? null : identityText(raw.receipt_id, 256, "receipt_id"),
    identityText(raw.at, 64, "at"),
  );
}

function insertConnectorSensitivity(db: Database, raw: Record<string, unknown>): void {
  db.query(
    `INSERT INTO connector_sensitivity
       (connector_id, source_key, default_sensitivity, floor, set_by, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.connector_id, "connector_id"),
    asString(raw.source_key, "source_key"),
    asString(raw.default_sensitivity, "default_sensitivity"),
    asString(raw.floor, "floor"),
    asString(raw.set_by, "set_by"),
    asString(raw.at, "at"),
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
       (connector_id, source_key, config, secret_refs, connected_at, disconnected_at,
        implementation_version, consent_required)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.connector_id, "connector_id"),
    asString(raw.source_key, "source_key"),
    NULL_CONNECTION_CONFIG,
    "[]",
    asString(raw.connected_at, "connected_at"),
    asStringOrNull(raw.disconnected_at, "disconnected_at") ?? new Date().toISOString(),
    asString(raw.implementation_version ?? "", "implementation_version"),
    raw.consent_required === undefined ? 0 : raw.consent_required === 0 || raw.consent_required === 1 ? raw.consent_required : (() => { throw new Error("invalid consent requirement"); })(),
  );
}

function insertReceipt(db: Database, raw: Record<string, unknown>): void {
  const pagePath = asString(raw.page_path, "page_path");
  const archivePath = asStringOrNull(raw.archive_path, "archive_path");
  assertReceiptPaths({ page_path: pagePath, archive_path: archivePath });
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
    pagePath,
    asString(raw.claim_kind ?? "claim", "claim_kind"),
    asStringOrNull(raw.before_hash, "before_hash"),
    asString(raw.after_hash, "after_hash"),
    asString(raw.at, "at"),
    asString(raw.kind ?? "write", "kind"),
    asString(raw.page_action ?? "edit", "page_action"),
    archivePath,
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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function insertMachineByteIntent(db: Database, raw: Record<string, unknown>): void {
  if (Object.keys(raw).sort(compareCodeUnits).join(",") !== "after_hash,before_hash,receipt_id") {
    throw new Error("invalid machine-byte intent backup row");
  }
  const receiptId = raw.receipt_id;
  const beforeHash = raw.before_hash;
  const afterHash = raw.after_hash;
  if (!isUlid(receiptId) || (beforeHash !== null && !isSha256(beforeHash)) || !isSha256(afterHash)) {
    throw new Error("invalid machine-byte intent backup row");
  }
  if (db.query("SELECT 1 FROM canon_receipts WHERE receipt_id = ?").get(receiptId) !== null) {
    throw new Error("machine-byte intent conflicts with receipt");
  }
  db.query(
    `INSERT INTO canon_machine_byte_intents (receipt_id, before_hash, after_hash)
     VALUES (?, ?, ?)`,
  ).run(receiptId, beforeHash, afterHash);
}

function validateRestoredEventOrigins(db: Database): void {
  let after = "";
  for (;;) {
    const rows = db.query<EventRow, [string, number]>(`SELECT ${EVENT_COLUMNS} FROM events
      WHERE event_id>? ORDER BY event_id LIMIT ?`).all(after, PAGE);
    if (rows.length === 0) return;
    for (const row of rows) eventFromRow(row, db);
    after = rows.at(-1)!.event_id;
  }
}

function insertCheckpointRow(db: Database, raw: Record<string, unknown>): void {
  const connectorId = asString(raw.connector_id, "connector_id");
  const sourceKey = asString(raw.source_key, "source_key");
  const cursor = asStringOrNull(raw.cursor, "cursor");
  if (
    connectorId === "kizuki.producer.model" &&
    (sourceKey === "extract" || sourceKey === "extract-deferred-scan")
  ) {
    if (cursor !== null) writeRailCursor(db, connectorId, sourceKey, cursor);
    return;
  }
  db.query(
    `INSERT INTO checkpoints
       (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectorId,
    sourceKey,
    cursor,
    asString(raw.mode, "mode"),
    asString(raw.updated_at, "updated_at"),
    asString(raw.last_run_at, "last_run_at"),
    JSON.stringify(raw.last_result ?? {}),
  );
}

function insertDeferredInput(db: Database, raw: Record<string, unknown>): void {
  const expected = "checked_binding_digest,checked_revision,event_id,source_key";
  if (Object.keys(raw).sort().join(",") !== expected) throw new Error("invalid deferred extraction backup row");
  const eventId = asString(raw.event_id, "event_id");
  const sourceKey = asStringOrNull(raw.source_key, "source_key");
  const revision = asNumber(raw.checked_revision, "checked_revision");
  const digest = asString(raw.checked_binding_digest, "checked_binding_digest");
  if (!isUlid(eventId) || (sourceKey !== null && !isUlid(sourceKey)) || !Number.isSafeInteger(revision) || revision < 0 || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("invalid deferred extraction backup value");
  }
  const binding = db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(eventId)?.source_key ?? null;
  if (binding !== sourceKey || db.query("SELECT 1 FROM events WHERE event_id=?").get(eventId) === null) {
    throw new Error("deferred extraction backup source binding mismatch");
  }
  db.query(`INSERT INTO extract_deferred_inputs
    (event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,?,?,?)`).run(eventId, sourceKey, revision, digest);
}

function boundedStoredString(value: unknown, field: string, maxBytes: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`invalid durable extraction backup ${field}`);
  }
  return value;
}

function extractBatchValues(raw: Record<string, unknown>): readonly [
  string, string, string, string | null, string, string | null, string | null,
  string, string, string | null, string | null,
] {
  const expected = "batch_mode,created_at,cursor,deferred_inputs,drafts,input_ids,integrity,model_inputs,model_ref,outcome,previous_cursor";
  if (Object.keys(raw).sort().join(",") !== expected) throw new Error("invalid durable extraction backup row");
  const previous = boundedStoredString(raw.previous_cursor, "previous_cursor", 256)!;
  const cursor = boundedStoredString(raw.cursor, "cursor", 256)!;
  const drafts = boundedStoredString(raw.drafts, "drafts", 1_600_000)!;
  const modelRef = boundedStoredString(raw.model_ref, "model_ref", 2_048, true);
  const createdAt = boundedStoredString(raw.created_at, "created_at", 64)!;
  const inputIds = boundedStoredString(raw.input_ids, "input_ids", 4_096, true);
  const digest = boundedStoredString(raw.integrity, "integrity", 74, true);
  const outcome = boundedStoredString(raw.outcome, "outcome", 16)!;
  const mode = boundedStoredString(raw.batch_mode, "batch_mode", 16)!;
  const modelInputs = boundedStoredString(raw.model_inputs, "model_inputs", 8_192, true);
  const deferredInputs = boundedStoredString(raw.deferred_inputs, "deferred_inputs", 8_192, true);
  extractBatchFilingVersion(digest);
  if (!isRfc3339(createdAt) ||
      !["ok", "purged"].includes(outcome) || !["frontier", "deferred"].includes(mode)) {
    throw new Error("invalid durable extraction backup value");
  }
  return [previous, cursor, drafts, modelRef, createdAt, inputIds, digest, outcome, mode, modelInputs, deferredInputs];
}

function insertExtractBatch(db: Database, raw: Record<string, unknown>): void {
  const values = extractBatchValues(raw);
  db.query(`INSERT INTO extract_batches
    (previous_cursor,cursor,drafts,model_ref,created_at,input_ids,integrity,outcome,batch_mode,model_inputs,deferred_inputs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
}

function* streamRows(
  backupDir: string,
  manifest: ExportManifest,
  relativePath: string,
  required: boolean,
): Generator<Record<string, unknown>> {
  if (!Object.hasOwn(manifest.files, relativePath)) {
    if (required) throw new Error(`backup manifest is missing ${relativePath}`);
    return;
  }
  const path = join(backupDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`backup is missing ${relativePath}`);
  }
  const maxRowBytes = relativePath === "ledger/events.jsonl" ? MAX_EVENT_BACKUP_ROW_BYTES
    : relativePath === MACHINE_BYTE_INTENTS_BACKUP ? MAX_MACHINE_BYTE_INTENT_ROW_BYTES
    : relativePath === IDENTITY_BACKUP ? MAX_IDENTITY_BACKUP_ROW_BYTES
    : relativePath === SOURCE_INVENTORY_BACKUP ? MAX_SOURCE_INVENTORY_ROW_BYTES
    : relativePath === "ledger/purge_ops.jsonl" ? MAX_PURGE_OP_ROW_BYTES
    : relativePath === "ledger/purge_batches.jsonl" || relativePath === "ledger/purge_batch_receipts.jsonl" ? 16_384
    : relativePath === SOURCE_SURVIVOR_LINEAGE_BACKUP ? MAX_SOURCE_SURVIVOR_LINEAGE_ROW_BYTES : Infinity;
  let rows = 0;
  for (const row of readJsonl(path, maxRowBytes)) {
    if (relativePath === IDENTITY_BACKUP && ++rows > LEGACY_IDENTITY_SCAN_MAX_ROWS) {
      throw new Error("backup legacy identity row limit exceeded");
    }
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
  if (manifest.schema_versions.serve > supported.serve) {
    throw new Error(`backup serve schema ${manifest.schema_versions.serve} is newer than ${supported.serve}`);
  }
  const eventFormat = manifest.schema === LEGACY_BACKUP_SCHEMA ? "legacy" : "current";
  prepareDestination(destination);
  const parent = dirname(destination);
  mkdirPrivate(parent);

  const staging = join(
    parent,
    `${basenameSafe(destination)}${STAGING_MARK}${ulid()}.partial`,
  );

  try {
    mkdirPrivate(staging);
    writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
    options.onProgress?.("staging");
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

    const db = openLedger(join(staging, CONTROL_DIR, "kizuki.db"));
    try {
      options.onProgress?.("ledger");
      db.transaction(() => {
        if (eventFormat === "legacy") {
          // This database is private restore staging. No readers or file publication
          // exist until legacy validation, backfill and guard restoration commit.
          db.exec(`DROP TRIGGER events_identity_insert; DROP TRIGGER events_identity_update;
            DROP TRIGGER native_owner_hash_insert; DROP TRIGGER native_owner_hash_update;`);
        }
        for (const row of streamRows(source, manifest, "ledger/events.jsonl", true)) {
          throwIfAborted(options.signal);
          insertEvent(db, row, eventFormat);
        }
        for (const row of streamRows(source, manifest, "ledger/event_purges.jsonl", true)) {
          insertPurge(db, row);
        }
        for (const row of streamRows(source, manifest, "claims/claims.jsonl", false)) {
          insertClaimRow(db, row);
        }
        syncCompatProposals(db);
        for (const row of streamRows(source, manifest, "claims/supersessions.jsonl", false)) {
          insertSupersession(db, row);
        }
        for (const row of streamRows(source, manifest, "claims/bindings.jsonl", false)) {
          insertBinding(db, row);
        }
        let identityCount = 0;
        for (const row of streamRows(source, manifest, IDENTITY_BACKUP, manifest.schema === BACKUP_SCHEMA)) {
          insertIdentityLink(db, row, manifest.schema);
          identityCount += 1;
        }
        if (manifest.files[IDENTITY_BACKUP] !== undefined && identityCount !== manifest.files[IDENTITY_BACKUP]!.count) {
          throw new Error("backup legacy identity count mismatch");
        }
        // The same raw-byte and aggregate-reference budget governs export,
        // restore and purge. Opaque malformed support remains inert history.
        scanLegacyIdentityRows(db);
        for (const row of streamRows(source, manifest, "canon/receipts.jsonl", true)) {
          insertReceipt(db, row);
        }
        restoreSourceSurvivorLineage(db, source, manifest);
        for (const row of streamRows(source, manifest, "connections.jsonl", true)) {
          insertConnectionRow(db, row);
        }
        for (const row of streamRows(source, manifest, "checkpoints.jsonl", true)) {
          insertCheckpointRow(db, row);
        }
        const railsRequired = manifest.schema !== LEGACY_BACKUP_SCHEMA && manifest.schema_versions.ledger >= 17;
        let railCount = 0;
        for (const row of streamRows(source, manifest, RAIL_CURSORS_BACKUP, railsRequired)) {
          writeRailCursor(
            db,
            asString(row.rail, "rail"),
            asString(row.source_key, "source_key"),
            asString(row.cursor, "cursor"),
          );
          railCount += 1;
        }
        const railEntry = manifest.files[RAIL_CURSORS_BACKUP];
        if (railEntry !== undefined && railCount !== railEntry.count) {
          throw new Error("backup extract rail cursor count mismatch");
        }
        for (const row of streamRows(source, manifest, "ledger/connector_sensitivity.jsonl", false)) {
          insertConnectorSensitivity(db, row);
        }
        restoreSourcePolicy(db, source, manifest);
        restorePurgeHistory(db, source, manifest);
        let intentCount = 0;
        for (const row of streamRows(
          source,
          manifest,
          MACHINE_BYTE_INTENTS_BACKUP,
          eventFormat === "current",
        )) {
          insertMachineByteIntent(db, row);
          intentCount += 1;
        }
        if (eventFormat === "current" && intentCount !== manifest.files[MACHINE_BYTE_INTENTS_BACKUP]!.count) {
          throw new Error("backup machine-byte intent count mismatch");
        }
        const deferredPath = "serve/extract-deferred-inputs.jsonl";
        const deferredRequired = manifest.schema_versions.serve >= 8;
        let deferredCount = 0;
        for (const row of streamRows(source, manifest, deferredPath, deferredRequired)) {
          insertDeferredInput(db, row);
          deferredCount += 1;
        }
        if (deferredRequired && deferredCount !== manifest.files[deferredPath]!.count) {
          throw new Error("backup deferred extraction count mismatch");
        }
        let batchCount = 0;
        for (const row of streamRows(source, manifest, EXTRACT_BATCH_BACKUP, deferredRequired)) {
          insertExtractBatch(db, row);
          batchCount += 1;
        }
        if (deferredRequired && batchCount !== manifest.files[EXTRACT_BATCH_BACKUP]!.count) {
          throw new Error("backup durable extraction count mismatch");
        }
        if (eventFormat === "legacy") {
          bindLegacyEventOrigins(db);
          installEventIdentityGuards(db);
        }
        validateRestoredEventOrigins(db);
        validateDurableExtractStorage(db);
      }).immediate();

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
        recovery_warnings: [
          ...(!hasPurgeHistory(manifest) || hasUnassignedPurgeReceipts(db)
            ? [PURGE_HISTORY_RECOVERY_WARNING]
            : []),
          ...(!hasSourceSurvivorLineage(manifest)
            ? [LINEAGE_UNAVAILABLE_WARNING]
            : []),
          ...(manifest.schema_versions.serve < 8
            ? ["backup predates durable extraction recovery; an interrupted model decision was not preserved"]
            : []),
          ...(db.query("SELECT 1 FROM connections LIMIT 1").get() !== null
            ? [CONNECTION_RECOVERY_WARNING]
            : []),
        ],
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

const SOURCE_BACKUP_TABLES = ["source_grants", "source_event_bindings", "source_grant_receipts", "native_owner_evidence", "source_retrieval_stores", "source_store_inventory"] as const;
type SourceBackupTable = typeof SOURCE_BACKUP_TABLES[number];
const SOURCE_COLUMNS: Record<SourceBackupTable, readonly string[]> = {
  source_retrieval_stores: ["source_key", "store_id", "status"],
  source_store_inventory: ["source_key", "checked", "payload_complete", "erasure_report"],
  native_owner_evidence: ["event_id", "origin", "request_digest", "recorded_at", "filing_state", "event_content_hash"],
  source_grants: ["source_key", "connector_id", "revision", "status", "policy", "policy_digest", "updated_at", "revoke_operation", "purge_receipt_id"],
  source_event_bindings: ["event_id", "source_key", "grant_revision", "policy_digest"],
  source_grant_receipts: ["sequence", "operation_id", "request_digest", "receipt", "receipt_digest"],
};
function* sourcePolicyRows(db: Database, table: SourceBackupTable): Generator<Record<string, unknown>> {
  if (table === "source_store_inventory") {
    yield* boundedSourceInventoryRows(db);
    return;
  }
  // Fixed identifiers only; SQLite's iterator keeps the backup memory bounded.
  for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY ${SOURCE_COLUMNS[table][0]}`).iterate()) yield row;
}
const LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED = "legacy_identity_erasure_reconciliation_required";

function reconcileIdentityErasureReport(
  value: unknown,
  schema: BackupSchema,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_ERASURE_REPORT_BYTES ||
      Buffer.byteLength(value, "utf8") > MAX_ERASURE_REPORT_BYTES) {
    throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
  }
  let report: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    report = parsed as Record<string, unknown>;
  } catch {
    throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
  }
  if (!Object.hasOwn(report, "affected_identity_hashes")) {
    if (schema === BACKUP_SCHEMA) throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
    report.affected_identity_hashes = [];
    const normalized = JSON.stringify(report);
    if (Buffer.byteLength(normalized, "utf8") > MAX_ERASURE_REPORT_BYTES) {
      throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
    }
    return normalized;
  }
  if (!Array.isArray(report.affected_identity_hashes) || report.affected_identity_hashes.length !== 0) {
    throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
  }
  return value;
}

function* boundedSourceInventoryRows(db: Database): Generator<Record<string, unknown>> {
  const invalid = `erasure_report IS NOT NULL AND (typeof(erasure_report)!='text'
    OR length(CAST(erasure_report AS BLOB))>${MAX_ERASURE_REPORT_BYTES})`;
  for (const row of db.query<{
    source_key: string; checked: number; payload_complete: number;
    report_bytes: Uint8Array | null; invalid_report: number;
  }, []>(`SELECT source_key,checked,payload_complete,(${invalid}) AS invalid_report,
    CASE WHEN (${invalid}) THEN NULL ELSE CAST(erasure_report AS BLOB) END AS report_bytes
    FROM source_store_inventory ORDER BY source_key`).iterate()) {
    if (row.invalid_report !== 0) throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED);
    let report: string | null;
    try { report = row.report_bytes === null ? null : FATAL_UTF8.decode(row.report_bytes); }
    catch { throw new Error(LEGACY_IDENTITY_ERASURE_RECONCILIATION_REQUIRED); }
    // Validate the exact snapshot row before serialization, not just the live DB
    // before/after callbacks. Forbidden bytes never enter a new backup stream.
    yield {
      source_key: row.source_key, checked: row.checked, payload_complete: row.payload_complete,
      erasure_report: reconcileIdentityErasureReport(report, BACKUP_SCHEMA),
    };
  }
}

function assertSourceInventoryIdentityErasure(db: Database): void {
  for (const _row of boundedSourceInventoryRows(db)) { /* validate every bounded row */ }
}

function hasPurgeHistory(manifest: ExportManifest): boolean {
  const entries = PURGE_HISTORY_TABLES.map(table => manifest.files[`ledger/${table}.jsonl`]);
  const present = entries.filter(entry => entry !== undefined).length;
  if (present === 0) return false;
  if (present !== entries.length || manifest.schema !== BACKUP_SCHEMA ||
      (manifest.schema_versions.ledger !== 19 && manifest.schema_versions.ledger !== 20) ||
      entries.some(entry => entry === undefined || !Number.isSafeInteger(entry.count) || entry.count < 0 ||
        !Number.isSafeInteger(entry.size) || entry.size < 0)) {
    throw new Error("backup completed purge history streams are incomplete or incompatible");
  }
  return true;
}

function hasSourceSurvivorLineage(manifest: ExportManifest): boolean {
  return manifest.schema === BACKUP_SCHEMA && manifest.schema_versions.ledger >= 20 &&
    manifest.files[SOURCE_SURVIVOR_LINEAGE_BACKUP] !== undefined;
}

function restoreSourceSurvivorLineage(db: Database, backup: string, manifest: ExportManifest): void {
  if (!hasSourceSurvivorLineage(manifest)) return;
  const path = SOURCE_SURVIVOR_LINEAGE_BACKUP;
  let count = 0;
  for (const row of streamRows(backup, manifest, path, true)) {
    restoreSourceSurvivorLineageRow(db, row);
    count += 1;
    if (count > MAX_SOURCE_SURVIVOR_LINEAGE_ROWS) throw new Error("backup source-survivor lineage exceeds its bound");
  }
  if (count !== manifest.files[path]!.count) throw new Error("backup source-survivor lineage count mismatch");
  assertSourceSurvivorLineageGraph(db);
}

function purgeColumnLimit(column: string): number {
  if (column === "ids") return MAX_PURGE_IDS_BYTES;
  if (column === "proof") return MAX_PURGE_PROOF_BYTES;
  if (column === "store") return 4_096;
  if (column === "state") return 16;
  if (column === "created_at" || column === "done_at") return 64;
  return 1_024;
}

function purgeHistoryValues(table: PurgeHistoryTable, row: Record<string, unknown>): string[] {
  const columns = PURGE_HISTORY_COLUMNS[table];
  if (Object.keys(row).sort().join() !== [...columns].sort().join()) {
    throw new Error("invalid completed purge history row");
  }
  return columns.map(column => {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > purgeColumnLimit(column) ||
        ((column === "created_at" || column === "done_at") && !isRfc3339(value)) ||
        (column === "state" && value !== (table === "purge_batches" ? "ready" : "done"))) {
      throw new Error("invalid completed purge history value");
    }
    return value;
  });
}

function* purgeHistoryRows(db: Database, table: PurgeHistoryTable): Generator<Record<string, unknown>> {
  // Fixed table/column identifiers only. Refuse oversized stored text before it
  // crosses into JavaScript, including JSON which must still be parsed below.
  const fields = PURGE_HISTORY_COLUMNS[table].map(column =>
    `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${purgeColumnLimit(column)} THEN CAST(${column} AS BLOB) ELSE NULL END AS ${column}`);
  const order = table === "purge_batches" ? "created_at,batch_id"
    : table === "purge_batch_receipts" ? "batch_id,receipt_id" : "created_at,op_id";
  for (const stored of db.query<Record<string, Uint8Array | null>, []>(`SELECT ${fields.join()} FROM ${table} ORDER BY ${order}`).iterate()) {
    const row: Record<string, unknown> = {};
    for (const column of PURGE_HISTORY_COLUMNS[table]) {
      const bytes = stored[column];
      if (bytes === null || bytes === undefined) throw new Error("invalid completed purge history value");
      try { row[column] = FATAL_UTF8.decode(bytes); }
      catch { throw new Error("invalid completed purge history UTF-8"); }
    }
    purgeHistoryValues(table, row);
    if (table === "purge_ops") validateCompletedPurgeOp(db, row);
    yield row;
  }
}

function purgeHistoryEventIds(db: Database, batchId: string): string[] {
  const ids: string[] = [];
  let bytes = 0;
  for (const row of db.query<{ event_id: string | null }, [string, string]>(
    `SELECT CASE WHEN length(CAST(event_id AS BLOB))<=1024 THEN event_id ELSE NULL END AS event_id FROM (
       SELECT e.event_id FROM purge_batch_receipts m JOIN event_purges e USING(receipt_id) WHERE m.batch_id=?
       UNION SELECT b.event_id FROM source_event_bindings b JOIN source_grants g USING(source_key) WHERE g.purge_receipt_id=?
     ) ORDER BY event_id`,
  ).iterate(batchId, batchId)) {
    if (row.event_id === null || row.event_id.length === 0 ||
        (bytes += Buffer.byteLength(row.event_id, "utf8") + 4) > MAX_PURGE_IDS_BYTES) {
      throw new Error("completed purge provenance inventory exceeds its bound");
    }
    ids.push(row.event_id);
  }
  return ids;
}

function validateCompletedPurgeOp(db: Database, row: Record<string, unknown>): void {
  let ids: unknown;
  let raw: unknown;
  try { ids = JSON.parse(row.ids as string); raw = JSON.parse(row.proof as string); }
  catch { throw new Error("invalid completed purge operation JSON"); }
  if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 4_096) ||
      !isPlainObject(raw) || Object.keys(raw).sort().join() !== "at,checked,found,method,provenance,schema,store" ||
      raw["schema"] !== "kizuki.purge-proof/v1" || !isPlainObject(raw["provenance"]) ||
      Object.keys(raw["provenance"]).sort().join() !== "at,checked,found,method,scope,store") {
    throw new Error("invalid completed purge operation proof");
  }
  const proof = validateAbsenceProof(raw, ids);
  const provenance = validateProvenanceAbsenceProof(raw["provenance"], purgeHistoryEventIds(db, row.receipt_id as string));
  if (proof.store !== row.store || provenance.store !== row.store || proof.found.length !== 0 || provenance.found.length !== 0) {
    throw new Error("completed purge operation proof does not match its scope");
  }
}

function assertCompletedPurgeHistory(db: Database): void {
  if (db.query(`SELECT 1 FROM purge_batch_receipts m
      LEFT JOIN event_purges e USING(receipt_id) LEFT JOIN purge_batches b USING(batch_id)
      WHERE e.receipt_id IS NULL OR b.batch_id IS NULL LIMIT 1`).get() !== null ||
      db.query(`SELECT 1 FROM purge_batches b WHERE
        NOT EXISTS (SELECT 1 FROM purge_batch_receipts m WHERE m.receipt_id=b.batch_id AND m.batch_id=b.batch_id)
        AND NOT EXISTS (SELECT 1 FROM source_grants g WHERE g.purge_receipt_id=b.batch_id AND g.status='purged') LIMIT 1`).get() !== null ||
      db.query(`SELECT 1 FROM purge_batch_receipts m JOIN purge_batches b ON b.batch_id=m.receipt_id
        WHERE m.batch_id!=b.batch_id LIMIT 1`).get() !== null ||
      db.query(`SELECT 1 FROM purge_ops o LEFT JOIN purge_batches b ON b.batch_id=o.receipt_id
        WHERE b.batch_id IS NULL LIMIT 1`).get() !== null) {
    throw new Error("completed purge history has unresolved references");
  }
  for (const table of PURGE_HISTORY_TABLES) {
    for (const _row of purgeHistoryRows(db, table)) { /* validate the current database cut */ }
  }
}

function hasUnassignedPurgeReceipts(db: Database): boolean {
  return db.query(`SELECT 1 FROM event_purges e WHERE NOT EXISTS
    (SELECT 1 FROM purge_batch_receipts m WHERE m.receipt_id=e.receipt_id) LIMIT 1`).get() !== null;
}

function restorePurgeHistory(db: Database, backup: string, manifest: ExportManifest): void {
  if (!hasPurgeHistory(manifest)) return;
  for (const table of PURGE_HISTORY_TABLES) {
    const columns = PURGE_HISTORY_COLUMNS[table];
    const insert = db.query(`INSERT INTO ${table} (${columns.join()}) VALUES (${columns.map(() => "?").join()})`);
    let count = 0;
    const path = `ledger/${table}.jsonl`;
    for (const row of streamRows(backup, manifest, path, true)) {
      insert.run(...purgeHistoryValues(table, row));
      count += 1;
    }
    if (count !== manifest.files[path]!.count) throw new Error("backup completed purge history count mismatch");
  }
  assertCompletedPurgeHistory(db);
}

function assertNoPendingPurgeExport(db: Database): void {
  if (db.query("SELECT 1 FROM canon_holds LIMIT 1").get() !== null ||
      (tableExists(db, "purge_ops") && db.query("SELECT 1 FROM purge_ops WHERE state!='done' LIMIT 1").get() !== null) ||
      db.query("SELECT 1 FROM purge_batches WHERE state!='ready' LIMIT 1").get() !== null) {
    throw new Error("purge_recovery_pending");
  }
  assertCompletedPurgeHistory(db);
}

function assertSourceExport(db: Database): void {
  assertSourceInventoryIdentityErasure(db);
  if (db.query("SELECT 1 FROM canon_source_erasure_intents LIMIT 1").get() !== null) throw new Error("source_erasure_recovery_pending");
  if (sourcePolicyEpoch(db) === 0) return;
  for (const row of db.query<{ source_key: string }, []>("SELECT source_key FROM source_grants").iterate()) {
    const grant = inspectSourceGrant(db, row.source_key)!;
    if (grant.status === "denied" || (grant.status === "active" && !grant.policy.purposes.includes("export"))) throw new Error("source_export_denied");
  }
  // Native purge currently retains derived claim rows. Status alone cannot
  // authorize copying their payload after a source denial.
  for (const row of db.query<{ provenance: string }, []>("SELECT provenance FROM claims WHERE status!='purged' OR length(body)>0 OR object IS NOT NULL OR target IS NOT NULL OR subject IS NOT NULL OR predicate IS NOT NULL OR model_ref IS NOT NULL OR subjects!='[]' OR frontmatter!='{}'").iterate()) {
    const ids = JSON.parse(row.provenance) as string[];
    const managed = ids.filter(id => db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(id) !== null);
    if (!sourceEventsAllowed(db, managed, { owner: true, purpose: "export" })) throw new Error("source_export_denied");
  }
  for (const row of db.query<{ event_id: string }, []>("SELECT event_id FROM source_event_bindings WHERE event_id IN (SELECT event_id FROM events)").iterate()) {
    if (!sourceEventsAllowed(db, [row.event_id], { owner: true, purpose: "export" })) throw new Error("source_export_denied");
  }
}
function restoreSourcePolicy(db: Database, backup: string, manifest: ExportManifest): void {
  for (const table of SOURCE_BACKUP_TABLES) {
    const required = manifest.schema_versions.ledger >= (table === "native_owner_evidence" ? 12 : table === "source_store_inventory" ? 14 : table === "source_retrieval_stores" ? 13 : 11);
    const path = `ledger/${table}.jsonl`;
    if (required && manifest.files[path] === undefined) throw new Error("backup source policy stream missing");
    for (const row of streamRows(backup, manifest, path, required)) {
      if (table === "native_owner_evidence" && manifest.schema === LEGACY_BACKUP_SCHEMA) {
        if (Object.hasOwn(row, "event_content_hash")) throw new Error("legacy native owner proof contains a current field");
        row["event_content_hash"] = db.query<{ content_hash: string }, [string]>("SELECT content_hash FROM events WHERE event_id=?")
          .get(asString(row["event_id"], "event_id"))?.content_hash ?? null;
      }
      if(table==="source_grant_receipts" && manifest.schema_versions.ledger<15 && row["receipt_digest"]===undefined) row["receipt_digest"]=null;
      if(table==="source_store_inventory" && manifest.schema_versions.ledger<14 && row["erasure_report"]===undefined) row["erasure_report"]=null;
      if (table === "source_store_inventory") row["erasure_report"] = reconcileIdentityErasureReport(row["erasure_report"], manifest.schema);
      const columns = SOURCE_COLUMNS[table];
      if (Object.keys(row).sort().join() !== [...columns].sort().join()) throw new Error("invalid source policy backup row");
      const values = columns.map(column => {
        const value = row[column];
        if (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error("invalid source policy backup value");
        return value as string | number | null;
      });
      db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
    }
  }
  assertSourceInventoryIdentityErasure(db);
  for(const row of db.query<{receipt:string;receipt_digest:string|null},[]>("SELECT receipt,receipt_digest FROM source_grant_receipts").iterate()) {if(row.receipt_digest!==null && row.receipt_digest!==new Bun.CryptoHasher("sha256").update(row.receipt).digest("hex"))throw new Error("backup source receipt integrity mismatch");}
  for (const row of db.query<{ event_id:string; origin:string; request_digest:string; recorded_at:string; filing_state:string }, []>("SELECT * FROM native_owner_evidence").iterate()) {
    if (row.origin !== "correction" || !/^[a-f0-9]{64}$/.test(row.request_digest) || !isRfc3339(row.recorded_at) || !["recorded","filed","failed"].includes(row.filing_state) || db.query("SELECT 1 FROM source_event_bindings WHERE event_id=?").get(row.event_id) !== null || db.query("SELECT 1 FROM events WHERE event_id=?").get(row.event_id) === null) throw new Error("invalid native owner evidence backup");
  }
  for (const row of db.query<{ source_key: string }, []>("SELECT source_key FROM source_grants").iterate()) {
    const grant = inspectSourceGrant(db, row.source_key)!;
    const connection = db.query<{ connector_id: string }, [string]>("SELECT connector_id FROM connections WHERE source_key=?").get(grant.source_key);
    if (connection?.connector_id !== grant.connector_id) throw new Error("backup source enrollment mismatch");
    const latest = db.query<{ receipt: string }, [string]>("SELECT receipt FROM source_grant_receipts WHERE json_extract(receipt,'$.source_key')=? ORDER BY sequence DESC LIMIT 1").get(grant.source_key);
    if (latest === null) throw new Error("backup source receipt missing");
    const receipt = JSON.parse(latest.receipt) as Record<string, unknown>;
    if (receipt.revision !== grant.revision || receipt.status !== grant.status || receipt.policy_digest !== grant.policy_digest) throw new Error("backup source receipt mismatch");
  }
  for (const row of db.query<{ event_id: string; connector_id: string; source_key: string; grant_revision: number }, []>("SELECT b.*,e.connector_id FROM source_event_bindings b LEFT JOIN events e ON e.event_id=b.event_id").iterate()) {
    const grant = inspectSourceGrant(db, row.source_key);
    if (grant === null || row.grant_revision < 1 || row.grant_revision > grant.revision || (row.connector_id !== null && row.connector_id !== grant.connector_id)) throw new Error("backup source binding mismatch");
  }
}
