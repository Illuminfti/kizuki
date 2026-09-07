import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { listConnections, restoreVault, verifyBackup } from "@kizuki/core";
import { sealLedger } from "@kizuki/core/internal";
import { UsageError, parseArguments } from "../args";
import { connectionStateIsCredentialFree } from "../connections";
import { openVaultDb } from "../context";
import { tryRefreshDerived } from "../derived";
import type { CliIo, Command } from "./index";

/** Matches core STATE_CONNECTION_CONFIG; kept local to avoid expanding the public surface. */
const STATE_CONNECTION_CONFIG =
  '{"schema":"kizuki.connection-config/v1","state_ref_index":0}';

/**
 * Portable restore (#534) writes every connection row as disconnected history
 * with secret_refs stripped. A `none`-auth connector's state was copied into
 * the backup by export (never a credential), so restore can put those bytes
 * back, rebind `file:connections/<source_key>.state`, and clear
 * disconnected_at — the connection becomes usable again without re-enrollment.
 * Sign-in connectors stay disconnected / state-missing.
 */
function restoreCredentialFreeConnectionState(
  db: Database,
  backupDir: string,
  into: string,
): number {
  let restored = 0;
  const connectionsDir = join(into, ".kizuki", "connections");
  for (const connection of listConnections(db, { includeDisconnected: true })) {
    if (!connectionStateIsCredentialFree(connection.connector_id)) continue;
    const relative = `connections/${connection.source_key}.state`;
    const from = join(backupDir, relative);
    if (!existsSync(from)) continue;
    const bytes = readFileSync(from);
    mkdirSync(connectionsDir, { recursive: true, mode: 0o700 });
    chmodSync(connectionsDir, 0o700);
    const to = join(into, ".kizuki", relative);
    writeFileSync(to, bytes, { mode: 0o600 });
    chmodSync(to, 0o600);
    const ref = `file:${relative}`;
    db.query(
      `UPDATE connections
          SET config = ?, secret_refs = ?, disconnected_at = NULL
        WHERE connector_id = ? AND source_key = ?`,
    ).run(
      STATE_CONNECTION_CONFIG,
      JSON.stringify([ref]),
      connection.connector_id,
      connection.source_key,
    );
    restored += 1;
  }
  return restored;
}

export const restoreCommand: Command = {
  name: "restore",
  usage: "restore --from DIR [--into DIR] [--verify]",
  summary: "verify a backup and restore it into an empty directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--from", "--into"],
      flags: ["--verify"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const from = parsed.options.get("--from");
    if (from === undefined) throw new UsageError(this.usage);
    const backupDir = resolve(from);
    const into = parsed.options.get("--into");
    if (into === undefined) {
      const manifest = verifyBackup(backupDir);
      io.out(`verified=${backupDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      if (manifest.schema_versions.serve < 8) {
        io.out("warning=backup predates durable extraction recovery; an interrupted model decision was not preserved");
      }
      return 0;
    }
    const target = resolve(into);
    const report = restoreVault(backupDir, target);
    io.out(`vault=${target}`);
    io.out(
      [
        `events=${report.events}`,
        `claims=${report.claims}`,
        `receipts=${report.receipts}`,
        `vault_files=${report.vault_files}`,
        `doctor_valid=${report.doctor.valid}`,
        `doctor_invalid=${report.doctor.invalid}`,
      ].join(" "),
    );
    for (const warning of report.recovery_warnings) io.out(`warning=${warning}`);
    const db = openVaultDb(target);
    try {
      const connectionState = restoreCredentialFreeConnectionState(db, backupDir, target);
      io.out(`connection_state=${connectionState}`);
      const derived = tryRefreshDerived(db, target);
      for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
      sealLedger(target, db);
    } finally {
      db.close();
    }
    return 0;
  },
};
