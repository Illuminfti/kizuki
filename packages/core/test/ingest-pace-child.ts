import { join } from "node:path";
import type { Connector, HealthReport, Manifest, PurgePlan, SecretResolver, SyncBatch } from "../src/contracts/connector";
import { registerConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { setSourceGrant } from "../src/ledger/source-grants";
import { runToCompletion } from "../src/ingest/run";
import { beginIngest } from "../src/ingest/pace";
import { validEvent } from "./fixtures";

/**
 * A long CLI writer over synthetic events: batches of 200 until `durationMs`
 * has passed, committing event after event the way a large import does.
 * Prints `writing` once it starts and a JSON summary when it ends.
 */
const [vault, durationArg, mode] = process.argv.slice(2);
const durationMs = Number(durationArg);
if (vault === undefined || !Number.isSafeInteger(durationMs) || (mode !== "paced" && mode !== "unpaced")) {
  throw new Error("vault, duration and mode (paced or unpaced) are required");
}
const SOURCE = "01J00000000000000000000SRC";
const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
registerConnection(db, "fixture", SOURCE);
setSourceGrant(db, {
  source_key: SOURCE, expected_revision: 0, operation_id: "pace-fixture-grant",
  policy: {
    purposes: ["capture", "recall", "session", "correction", "audit", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
  },
});
const started = Date.now();
let sequence = 0;

const connector: Connector = {
  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1", connector_id: "fixture", version: "1.0.0", kinds: ["message"],
      capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true }, required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["none"],
    };
  },
  health: (): Promise<HealthReport> => { throw new Error("not used"); },
  connect: (_resolve: SecretResolver) => Promise.resolve(),
  backfill(): Promise<SyncBatch> {
    const more = Date.now() - started < durationMs;
    const events = more ? Array.from({ length: 200 }, () => ({ ...validEvent(), source_record_id: `rec-${sequence += 1}`, text: `synthetic record ${sequence}` })) : [];
    return Promise.resolve({ events, cursor: more ? `c${sequence}` : null, has_more: more });
  },
  sync: () => Promise.resolve({ events: [], cursor: null }),
  revoke: () => Promise.resolve(),
  purgeSource: (subject_id: string): Promise<PurgePlan> => Promise.resolve({ subject_id, source_record_ids: [], unreachable_source_record_ids: [] }),
  fixture: () => Promise.resolve([]),
};

const ingest = mode === "paced" ? beginIngest(db, vault) : null;
process.stdout.write("writing\n");
try {
  const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill", { vault_path: vault, ...(ingest === null ? {} : { pace: ingest.pace }) });
  process.stdout.write(`${JSON.stringify({ stored: result.stored, errors: result.errors, ms: Date.now() - started })}\n`);
} finally {
  ingest?.[Symbol.dispose]();
  db.close();
}
