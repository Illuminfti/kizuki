import { getCheckpoint, LedgerLeaseHeldError, listConnections, registerConnection, runServeDaemon, runToCompletion, setSourceGrant } from "@kizuki/core";
import type { Connector } from "@kizuki/core";
import { withVault } from "../../src/context";
import type { CliIo } from "../../src/commands";
import { validEvent } from "../../../core/test/fixtures";

const [vault, mode] = process.argv.slice(2);
if (vault === undefined || (mode !== "slow" && mode !== "resume")) throw new Error("vault and fixture mode required");
const source = "01J00000000000000000000SRC";
const io: CliIo = {
  env: process.env, vaultOverride: vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
  out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`),
  prompt: async () => { throw new Error("fixture is noninteractive"); },
};
const connector: Connector = {
  manifest: () => ({ schema: "kizuki.connector/v1", connector_id: "fixture", version: "1.0.0", kinds: ["message"],
    capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true },
    required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["none"] }),
  health: async () => { throw new Error("fixture uses sync only"); }, connect: async () => {},
  backfill: async () => { throw new Error("fixture uses sync"); },
  sync: async () => {
    io.out("requested");
    if (mode === "slow") await Bun.sleep(58_000);
    return { events: [validEvent()], cursor: "fixture-page-1", has_more: false };
  },
  revoke: async () => {}, purgeSource: async () => { throw new Error("fixture uses sync only"); },
  fixture: async () => [validEvent()],
};
let completed = false;
try {
  await withVault(io, async ctx => {
    if (!listConnections(ctx.db).some(row => row.connector_id === "fixture")) {
      registerConnection(ctx.db, "fixture", source);
      setSourceGrant(ctx.db, { source_key: source, expected_revision: 0, operation_id: "fixture-slow-grant",
        policy: { purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" },
      });
    }
    if (mode === "resume") {
      const result = await runToCompletion(ctx.db, connector, "fixture", source, "sync", { vault_path: vault });
      io.out(JSON.stringify({ stored: result.stored, errors: result.errors, cursor: getCheckpoint(ctx.db, "fixture", source)?.sync_cursor }));
    } else {
      await runServeDaemon(ctx.db, vault, { once: true, rails: ["sync"], http: false,
        acquireRuntime: async ({ signal }) => ({
          hooks: { sync: async () => {
            const result = await runToCompletion(ctx.db, connector, "fixture", source, "sync", { signal, vault_path: vault });
            return { events_synced: result.stored + result.duplicates, events_stored: result.stored,
              events_duplicate: result.duplicates, events_self_skipped: 0, errors: result.errors };
          } }, close: async () => {},
        }),
      });
    }
    completed = true;
  }, { retrieval: "none", nonblockingSeal: true });
} catch (error) {
  if (!(completed && error instanceof LedgerLeaseHeldError)) throw error;
  io.out("seal-deferred");
}
