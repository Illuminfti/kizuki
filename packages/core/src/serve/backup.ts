import { lstatSync, mkdirSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { assertSeparated, BACKUP_SCHEMA, exportVault, restoreVault, verifyBackup } from "../export";
import { isUlid } from "../util/ulid";
import { openOwnedDirectory, type OwnedDirectory, type OwnedDirectoryIdentity } from "../util/owned-directory";
import { loadBackupSelection } from "./config";
import type { RailRunContext } from "./rail-definition";
import { readVaultId } from "./vault-id";
import type { RunReceipt } from "./types";

const MAX_ENTRIES = 2_000;
const ARCHIVE = /^kizuki-backup-([0-9A-HJKMNP-TV-Z]{26})-(\d{8}T\d{9}Z)-([0-9A-HJKMNP-TV-Z]{26})$/i;
function fail(reason: string): never { throw new Error(`backup:${reason}`); }

function openDestination(vault: string, destination: string): OwnedDirectory {
  try { assertSeparated(vault, destination); } catch { fail("destination:inside_vault"); }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) fail("destination_unsafe");
  // This rejects symlink parents too; subsequent cleanup is descriptor-relative.
  return openOwnedDirectory(destination);
}

function archiveNames(root: OwnedDirectory, path: string, vaultId: string): string[] {
  root.assertCurrent();
  const dir = opendirSync(path), names: string[] = [];
  let count = 0;
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (++count > MAX_ENTRIES) fail("retention_bound");
      const match = ARCHIVE.exec(entry.name);
      if (match?.[1]?.toLowerCase() !== vaultId.toLowerCase() || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  root.assertCurrent();
  return names.sort().reverse();
}

function prune(root: OwnedDirectory, path: string, vaultId: string, current: string, retain: number): void {
  const names = archiveNames(root, path, vaultId);
  let kept = 1; // The just-verified archive is always kept, even after a clock rollback.
  for (const name of names) {
    if (name === current) continue;
    const identity = root.childIdentity(name);
    if (identity === null) continue;
    const bytes = root.readFile([name, "manifest.json"], 1_048_576);
    if (bytes === null) continue;
    let manifest: unknown;
    try { manifest = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { continue; }
    if (manifest === null || typeof manifest !== "object" || !("schema" in manifest)
      || manifest.schema !== BACKUP_SCHEMA || !("vault_id" in manifest) || manifest.vault_id !== vaultId
      || !("complete" in manifest) || manifest.complete !== true) continue;
    if (kept++ < retain) continue;
    root.removeTree(name, identity);
  }
}

/** The normal public export and restore paths perform the actual backup and verification. */
export function runScheduledBackup(context: RailRunContext): Partial<RunReceipt> {
  const config = loadBackupSelection(context.vault_path);
  if (config.state === "off") return { status: "ok" };
  if (config.state === "invalid") return { status: "failed", errors: ["backup:invalid_config"] };
  let root: OwnedDirectory | undefined, temporary: { name: string; identity: OwnedDirectoryIdentity } | undefined;
  let stage = "destination";
  try {
    const vaultId = readVaultId(context.vault_path);
    if (vaultId === null || !isUlid(vaultId.toUpperCase()) || !isUlid(context.run_id)) fail("identity:unavailable");
    const now = new Date(context.started_at);
    if (!Number.isFinite(now.getTime())) fail("invalid_time");
    const name = `kizuki-backup-${vaultId}-${now.toISOString().replace(/[-:.]/g, "")}-${context.run_id}`;
    root = openDestination(context.vault_path, config.dir);
    archiveNames(root, config.dir, vaultId); // Refuse unbounded maintenance before exporting.
    const checkpoint = (): void => { root!.assertCurrent(); if (context.stop_requested?.()) fail("stop_requested"); };
    checkpoint();
    stage = "export";
    const archive = join(config.dir, name);
    const manifest = exportVault(context.db, context.vault_path, archive, { onProgress: checkpoint });
    checkpoint();
    stage = "verify";
    verifyBackup(archive);
    const temporaryName = `.kizuki-restore-check-${context.run_id}`;
    temporary = { name: temporaryName, identity: root.createStaging(temporaryName) };
    const restored = restoreVault(archive, join(config.dir, temporaryName, "vault"), { onProgress: checkpoint });
    if (restored.events !== manifest.snapshot.event_count || restored.receipts !== manifest.files["canon/receipts.jsonl"]?.count || restored.doctor.invalid !== 0) fail("restore_mismatch");
    checkpoint();
    root.removeTree(temporary.name, temporary.identity);
    temporary = undefined;
    stage = "retention";
    prune(root, config.dir, vaultId, name, config.retain);
    return { status: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /^backup:[a-z_:]+$/.test(message) ? message
      : message.startsWith("source_export_denied") ? "backup:source:export_denied" : `backup:${stage}_failed`;
    return { status: reason === "backup:stop_requested" ? "stopped" : "failed", errors: [reason],
      ...(reason === "backup:stop_requested" ? { stopped: "serve:stop_requested" } : {}) };
  } finally {
    // Fail closed on changed custody. Never delete through a replacement path.
    try { if (root !== undefined && temporary !== undefined) root.removeTree(temporary.name, temporary.identity); }
    finally { root?.close(); }
  }
}
