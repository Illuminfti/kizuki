import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportVault } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { connectionStateIsCredentialFree, listHostConnections } from "../connections";
import { withVault } from "../context";
import type { VaultContext } from "../context";
import type { CliIo, Command } from "./index";

function countPrefix(
  files: Record<string, { count: number }>,
  prefix: string,
): number {
  return Object.keys(files).filter((key) => key.startsWith(prefix)).length;
}

function countFile(
  files: Record<string, { count: number }>,
  key: string,
): number {
  return files[key]?.count ?? 0;
}

/**
 * Core keeps every connector's connection state opaque and excludes all of
 * it from a backup, because for a sign-in connector that state is a real
 * credential. A `none`-auth connector's state is never a credential — it is
 * the same plain config (e.g. a local path) `connections.jsonl` already
 * carries a reference to — so its bytes are safe to copy alongside the
 * backup core already wrote. This lives in the CLI, not core, because only
 * the CLI knows a connector's auth mode; core is connector-agnostic.
 */
function exportCredentialFreeConnectionState(
  ctx: VaultContext,
  outDir: string,
): number {
  let copied = 0;
  for (const host of listHostConnections(ctx.db, ctx.store)) {
    if (host.state === null) continue;
    if (!connectionStateIsCredentialFree(host.connection.connector_id)) continue;
    const ref = host.connection.secret_refs[0];
    if (host.connection.secret_refs.length !== 1 || ref === undefined) continue;
    const bytes = ctx.store.read(host.connection);
    if (bytes === null) continue;
    const relative = ref.slice("file:".length);
    const path = join(outDir, relative);
    mkdirSync(join(outDir, "connections"), { recursive: true, mode: 0o700 });
    chmodSync(join(outDir, "connections"), 0o700);
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    copied += 1;
  }
  return copied;
}

export const exportCommand: Command = {
  name: "export",
  usage: "export --out DIR",
  summary: "dump vault files and ledger tables into an empty directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--out"] });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    const out = parsed.options.get("--out");
    if (out === undefined) throw new UsageError(this.usage);
    const outDir = resolve(out);

    return withVault(io, async (ctx) => {
      const manifest = exportVault(ctx.db, ctx.vaultPath, outDir);
      const connectionStateCopied = exportCredentialFreeConnectionState(ctx, outDir);
      io.out(`manifest=${outDir}/manifest.json`);
      io.out(`schema=${manifest.schema} complete=${manifest.complete}`);
      io.out(
        [
          `vault_files=${countPrefix(manifest.files, "vault/")}`,
          `events=${countFile(manifest.files, "ledger/events.jsonl")}`,
          `purges=${countFile(manifest.files, "ledger/event_purges.jsonl")}`,
          `claims=${countFile(manifest.files, "claims/claims.jsonl")}`,
          `receipts=${countFile(manifest.files, "canon/receipts.jsonl")}`,
          `connections=${countFile(manifest.files, "connections.jsonl")}`,
          `checkpoints=${countFile(manifest.files, "checkpoints.jsonl")}`,
          `connection_state=${connectionStateCopied}`,
        ].join(" "),
      );
      return 0;
    });
  },
};
