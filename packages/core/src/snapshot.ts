import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { rebuildPageIndex } from "./canon";
import { RECEIPTS_PATH } from "./canon/receipt-path";
import {
  canonReadGeneration,
  inspectCanonRecovery,
} from "./canon/write-intent";
import { rebuildDerived } from "./derived";
import {
  assertNoPendingPurgeExport,
  assertSeparated,
  copyHashed,
  fsyncDirectory,
  hashFile,
  mkdirPrivate,
  pathUnder,
  prepareDestination,
  splitBackupPath,
  vaultInventory,
  writePrivateFile,
  type RestoreOptions,
  type RestoreReport,
} from "./export";
import { AGENT_NAME, inspectAgents } from "./agents/identity";
import { NULL_CONNECTION_CONFIG } from "./ledger/connection-state";
import { LEDGER_SCHEMA_VERSION, openLedger } from "./ledger/db";
import { readSchemaVersion } from "./ledger/integrity";
import { tableExists } from "./ledger/schema";
import { assertWorldState } from "./world/integrity";
import { ensureVaultId, readVaultId, vaultIdPath } from "./serve/vault-id";
import {
  openOwnedDirectory,
  OwnedDirectoryPublicationError,
  type OwnedDirectoryIdentity,
  type OwnedDirectory,
} from "./util/owned-directory";
import { ulid } from "./util/ulid";
import {
  assertVaultMutationScope,
  VaultMutationError,
  withVaultMutationSync,
} from "./vault/mutation-scope";
import { doctorVault } from "./vault/doctor";
import { hardenLedgerFile, initVault } from "./vault/init";

export const SNAPSHOT_SCHEMA = "kizuki.snapshot/v1" as const;
const MANIFEST = "manifest.json";
const LEDGER_FILE = "ledger.db";
const JOURNAL_FILE = "receipts/promotions.jsonl";
const INCOMPLETE = ".kizuki-snapshot-incomplete";
const STAGING_MARK = ".kizuki-snapshot-";
const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 100;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const AGENT_TABLES = [
  "agent_enrollments",
  "agent_grants",
  "agent_audit",
  "agents",
] as const;

export interface SnapshotManifest {
  schema: typeof SNAPSHOT_SCHEMA;
  vault_id: string | null;
  created_at: string;
  ledger_schema: number;
  events: number;
  receipts: number;
  /** Agents that held authority when the snapshot was taken; no credential or token hash is kept. */
  agents: string[];
  files: Record<string, { size: number; sha256: string }>;
  complete: true;
  manifest_sha256: string;
}

export interface SnapshotRestoreReport extends RestoreReport {
  /** Agents the snapshot was taken with; each needs a fresh enrollment in the restored vault. */
  agents: readonly string[];
}

export interface BackupOptions {
  /** How long to wait for the canon writer and for a pending canon write to finish. Default 30 s. */
  wait_ms?: number;
}

function digest(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sign(
  unsigned: Omit<SnapshotManifest, "manifest_sha256">,
): SnapshotManifest {
  return {
    ...unsigned,
    manifest_sha256: digest(`${JSON.stringify(unsigned, null, 2)}\n`),
  };
}

/** Receipt ids in a journal; a torn, duplicate or invalid line is a mismatch, not something to skip. */
function journalReceiptIds(path: string): string[] {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let id: unknown;
    try {
      id = (JSON.parse(line) as { receipt_id?: unknown }).receipt_id;
    } catch {
      id = undefined;
    }
    if (typeof id !== "string" || id.length === 0)
      throw new Error("receipt_journal_mismatch");
    ids.push(id);
  }
  return ids;
}

function assertJournalMatchesLedger(db: Database, journal: string): number {
  const ids = journalReceiptIds(journal);
  const rows = db
    .query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts")
    .all();
  if (new Set(ids).size !== ids.length || ids.length !== rows.length)
    throw new Error("receipt_journal_mismatch");
  const known = new Set(ids);
  if (rows.some((row) => !known.has(row.receipt_id)))
    throw new Error("receipt_journal_mismatch");
  return rows.length;
}

/**
 * A snapshot restores into the owner's own custody, so it needs no `export` purpose. It must still not
 * copy what a revocation is erasing, or leave the vault in a state restore cannot reproduce.
 */
function assertSnapshotAdmissible(db: Database): void {
  if (
    db.query("SELECT 1 FROM canon_source_erasure_intents LIMIT 1").get() !==
    null
  )
    throw new Error("source_erasure_recovery_pending");
  const denied = db
    .query<{ source_key: string; revoke_operation: string | null }, []>(
      "SELECT source_key,revoke_operation FROM source_grants WHERE status='denied' LIMIT 1",
    )
    .get();
  if (denied !== null) {
    throw new Error(
      `source_revocation_pending: source ${denied.source_key} is revoked and its purge is pending; finish it with kizuki connect resume-revocation --source ${denied.source_key} --operation-id ${denied.revoke_operation ?? "REVOKE_OPERATION"}`,
    );
  }
  assertNoPendingPurgeExport(db);
}

/** What the manifest states about the ledger, read from the snapshot copy so it always matches the bytes kept. */
interface LedgerFacts {
  schema: number;
  events: number;
  receipts: number;
  agents: string[];
}

/**
 * Snapshot the ledger with SQLite's own consistent read, which is safe beside the daemon's other writers.
 * Agent authority is then removed from the copy and the copy vacuumed, so no enrollment or token hash
 * survives in free pages.
 */
function snapshotLedger(db: Database, path: string, journal: string): LedgerFacts {
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  chmodSync(path, 0o600);
  const copy = new Database(path);
  try {
    const facts: LedgerFacts = {
      schema: readSchemaVersion(copy),
      events: copy.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!.count,
      receipts: assertJournalMatchesLedger(copy, journal),
      agents: inspectAgents(copy).filter(agent => agent.state === "active").map(agent => agent.name),
    };
    const present = AGENT_TABLES.some(table => tableExists(copy, table) && copy.query(`SELECT 1 FROM ${table} LIMIT 1`).get() !== null);
    if (!present) return facts;
    copy.exec("PRAGMA secure_delete=ON");
    copy.transaction(() => {
      for (const table of AGENT_TABLES) if (tableExists(copy, table)) copy.exec(`DELETE FROM ${table}`);
      if (tableExists(copy, "world_authorization_namespaces")) copy.exec("DELETE FROM world_authorization_namespaces WHERE principal_id<>'owner'");
    })();
    copy.exec("VACUUM");
    return facts;
  } finally {
    copy.close();
  }
}

function take(
  db: Database,
  vault: string,
  destination: string,
): SnapshotManifest | null {
  const recovery = inspectCanonRecovery(db);
  if (recovery.pending || recovery.projection_pending > 0) return null;
  assertSnapshotAdmissible(db);
  const parent = dirname(destination);
  mkdirPrivate(parent);
  const staging = join(
    parent,
    `${basename(destination)}${STAGING_MARK}${ulid()}.partial`,
  );
  mkdirPrivate(staging);
  try {
    writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
    const files: SnapshotManifest["files"] = {};
    const record = (
      path: string,
      entry: { size: number; sha256: string },
    ): void => {
      files[path] = { size: entry.size, sha256: entry.sha256 };
    };
    const facts = snapshotLedger(db, join(staging, LEDGER_FILE), join(vault, RECEIPTS_PATH));
    record(LEDGER_FILE, hashFile(join(staging, LEDGER_FILE)));
    for (const entry of vaultInventory(db, vault).files) {
      record(
        `vault/${entry.path}`,
        copyHashed(
          join(vault, entry.path),
          join(staging, "vault", entry.path),
          entry,
        ),
      );
    }
    if (existsSync(join(vault, RECEIPTS_PATH)))
      record(
        JOURNAL_FILE,
        copyHashed(join(vault, RECEIPTS_PATH), join(staging, JOURNAL_FILE)),
      );
    if (canonReadGeneration(db) !== recovery.generation)
      throw new Error("canon changed during backup");
    const manifest = sign({
      schema: SNAPSHOT_SCHEMA,
      vault_id: readVaultId(vault),
      created_at: new Date().toISOString(),
      ledger_schema: facts.schema,
      events: facts.events,
      receipts: facts.receipts,
      agents: facts.agents,
      files: sortedFiles(files),
      complete: true,
    });
    writePrivateFile(
      join(staging, MANIFEST),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    unlinkSync(join(staging, INCOMPLETE));
    fsyncDirectory(staging);
    prepareDestination(destination);
    renameSync(staging, destination);
    fsyncDirectory(parent);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function sortedFiles(
  files: SnapshotManifest["files"],
): SnapshotManifest["files"] {
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Snapshot a live vault into an empty directory that only `restoreSnapshot` reads. The snapshot holds the
 * canon writer, so no canon write is in flight, and waits while a crashed write is still pending.
 */
export async function backupVault(
  db: Database,
  vaultPath: string,
  outDir: string,
  options: BackupOptions = {},
): Promise<SnapshotManifest> {
  const vault = resolve(vaultPath);
  const destination = resolve(outDir);
  assertSeparated(vault, destination);
  prepareDestination(destination);
  const deadline = Date.now() + (options.wait_ms ?? DEFAULT_WAIT_MS);
  for (;;) {
    let blocked: string;
    try {
      const manifest = withVaultMutationSync({ vault_path: vault, db }, () =>
        take(db, vault, destination),
      );
      if (manifest !== null) return manifest;
      blocked =
        "canon_recovery_pending: a canon write is unfinished; start the service or run kizuki recover, then retry";
    } catch (error) {
      if (!(
        error instanceof VaultMutationError && error.code === "writer_busy"
      ))
        throw error;
      blocked =
        "writer_busy: another process holds the canon writer; retry when it finishes";
    }
    if (Date.now() >= deadline) throw new Error(blocked);
    await Bun.sleep(POLL_MS);
  }
}

/** Whether a directory is a snapshot, judged by its manifest alone. */
export function isSnapshotBackup(backupDir: string): boolean {
  try {
    const path = join(resolve(backupDir), MANIFEST);
    if (statSync(path).size > MAX_MANIFEST_BYTES) return false;
    return (
      (JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown })
        .schema === SNAPSHOT_SCHEMA
    );
  } catch {
    return false;
  }
}

function listFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(root, path) : [path];
    },
  );
}

/** Verify a snapshot's manifest, its complete file set and every byte, and return the manifest. */
export function verifySnapshot(backupDir: string): SnapshotManifest {
  const root = resolve(backupDir);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`backup directory is missing: ${backupDir}`);
  if (existsSync(join(root, INCOMPLETE)))
    throw new Error("snapshot is incomplete");
  const manifestPath = join(root, MANIFEST);
  if (
    !existsSync(manifestPath) ||
    lstatSync(manifestPath).size > MAX_MANIFEST_BYTES
  )
    throw new Error("snapshot manifest is missing");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as SnapshotManifest;
  if (manifest.schema !== SNAPSHOT_SCHEMA || manifest.complete !== true)
    throw new Error("snapshot manifest is not a complete kizuki.snapshot/v1");
  const { manifest_sha256: claimed, ...unsigned } = manifest;
  if (claimed !== digest(`${JSON.stringify(unsigned, null, 2)}\n`))
    throw new Error("snapshot manifest digest mismatch");
  if (
    !Number.isSafeInteger(manifest.ledger_schema) ||
    !Number.isSafeInteger(manifest.events) ||
    !Number.isSafeInteger(manifest.receipts) ||
    !Array.isArray(manifest.agents) ||
    !manifest.agents.every((name) => typeof name === "string" && AGENT_NAME.test(name)) ||
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    manifest.files[LEDGER_FILE] === undefined
  )
    throw new Error("snapshot manifest is malformed");
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (
      path !== LEDGER_FILE &&
      path !== JOURNAL_FILE &&
      !path.startsWith("vault/")
    )
      throw new Error(`snapshot lists an unexpected file: ${path}`);
    const actual = hashFile(pathUnder(root, splitBackupPath(path)));
    if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
      throw new Error(`snapshot file changed: ${path}`);
  }
  const unlisted = listFiles(root).filter(
    (path) => path !== MANIFEST && manifest.files[path] === undefined,
  );
  if (unlisted.length > 0)
    throw new Error("snapshot holds files its manifest does not list");
  return manifest;
}

/** Restore a snapshot into an empty directory; the result is a vault that passes doctor and accepts canon writes. */
export function restoreSnapshot(
  backupDir: string,
  targetDir: string,
  options: RestoreOptions = {},
): SnapshotRestoreReport {
  const source = resolve(backupDir);
  const destination = resolve(targetDir);
  assertSeparated(source, destination);
  const manifest = verifySnapshot(source);
  if (manifest.ledger_schema > LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `backup ledger schema ${manifest.ledger_schema} is newer than ${LEDGER_SCHEMA_VERSION}`,
    );
  }
  prepareDestination(destination);
  const parent = dirname(destination);
  mkdirPrivate(parent);
  const name = basename(destination);
  const staging = join(parent, `${name}${STAGING_MARK}${ulid()}.partial`);
  let parentDirectory: OwnedDirectory | undefined;
  let stagingIdentity: OwnedDirectoryIdentity | undefined;
  let staged: OwnedDirectory | undefined;
  let published = false,
    publicationUncertain = false;
  try {
    parentDirectory = openOwnedDirectory(parent);
    const destinationIdentity = parentDirectory.childIdentity(name);
    stagingIdentity = parentDirectory.createStaging(basename(staging));
    staged = openOwnedDirectory(staging);
    writePrivateFile(join(staging, INCOMPLETE), Buffer.from("incomplete\n"));
    options.onProgress?.("staging");
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (!path.startsWith("vault/")) continue;
      options.onProgress?.("vault");
      const parts = splitBackupPath(path);
      copyHashed(
        pathUnder(source, parts),
        pathUnder(staging, parts.slice(1)),
        entry,
      );
    }
    initVault(staging);
    if (manifest.vault_id !== null && !existsSync(vaultIdPath(staging)))
      writePrivateFile(
        vaultIdPath(staging),
        Buffer.from(`${manifest.vault_id}\n`),
      );
    ensureVaultId(staging);
    const ledgerPath = join(staging, ".kizuki", "kizuki.db");
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${ledgerPath}${suffix}`, { force: true });
    options.onProgress?.("ledger");
    copyHashed(
      join(source, LEDGER_FILE),
      ledgerPath,
      manifest.files[LEDGER_FILE],
    );
    if (manifest.files[JOURNAL_FILE] !== undefined) {
      rmSync(join(staging, RECEIPTS_PATH), { force: true });
      copyHashed(
        join(source, JOURNAL_FILE),
        join(staging, RECEIPTS_PATH),
        manifest.files[JOURNAL_FILE],
      );
    }
    const db = openLedger(ledgerPath);
    try {
      db.transaction(() => {
        const recovery = inspectCanonRecovery(db);
        if (recovery.pending || recovery.projection_pending > 0)
          throw new Error("snapshot holds an unfinished canon write");
        // Connector state and credentials stay outside a snapshot: every connection restores disconnected,
        // and the running service's lease belongs to the machine that took it.
        db.query(
          "UPDATE connections SET config=?, secret_refs='[]', disconnected_at=COALESCE(disconnected_at, ?)",
        ).run(NULL_CONNECTION_CONFIG, new Date().toISOString());
        if (tableExists(db, "leases")) db.exec("DELETE FROM leases");
        if (tableExists(db, "world_authorization_namespaces"))
          assertWorldState(db);
      }).immediate();
      const events = db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM events")
        .get()!.count;
      const receipts = assertJournalMatchesLedger(
        db,
        join(staging, RECEIPTS_PATH),
      );
      if (events !== manifest.events || receipts !== manifest.receipts)
        throw new Error("restored ledger does not match the snapshot manifest");
      rebuildDerived(db, staging);
      rebuildPageIndex({ db, vault_path: staging });
      const rebuilt: unknown = options.rebuildDerived?.(db, staging);
      if (rebuilt instanceof Promise)
        throw new Error("restore rebuild must be synchronous");
      if (db.inTransaction)
        throw new Error("restore rebuild left a transaction open");
      staged.assertCurrent();
      parentDirectory.assertCurrent();
      hardenLedgerFile(ledgerPath);
      const connections = db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM connections",
        )
        .get()!.count;
      const report: SnapshotRestoreReport = {
        connection_state: 0,
        vault_id: readVaultId(staging),
        events,
        claims: db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM claims")
          .get()!.count,
        receipts,
        vault_files: Object.keys(manifest.files).filter((path) =>
          path.startsWith("vault/"),
        ).length,
        doctor: doctorVault(staging).counts,
        recovery_warnings:
          connections === 0
            ? []
            : [
                "every connection restored disconnected; reconnect each source with kizuki connect",
              ],
        agents: manifest.agents,
      };
      db.close();
      unlinkSync(join(staging, INCOMPLETE));
      fsyncDirectory(staging);
      staged.assertCurrent();
      parentDirectory.assertCurrent();
      prepareDestination(destination);
      try {
        parentDirectory.publishStaging(
          basename(staging),
          stagingIdentity,
          name,
          destinationIdentity,
        );
        published = true;
      } catch (error) {
        if (error instanceof OwnedDirectoryPublicationError) {
          published = error.publication === "published";
          publicationUncertain = !error.cleanup_safe;
        } else publicationUncertain = true;
        throw error;
      }
      return report;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    if (!published && !publicationUncertain && stagingIdentity !== undefined)
      parentDirectory!.removeTree(basename(staging), stagingIdentity);
    throw error;
  } finally {
    staged?.close();
    parentDirectory?.close();
  }
}
