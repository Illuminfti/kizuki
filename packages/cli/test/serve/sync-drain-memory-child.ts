// Run the memory probe in a fresh process so earlier tests cannot warm its heap.
import { join } from "node:path";
import { ConnectionStateStore, getCheckpoint, listRunReceipts, runServeDaemon, thisProcess } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { CLAUDE_CODE_SESSIONS_CONNECTOR_ID } from "@kizuki/connectors";
import { createServeRuntime } from "../../src/serve-runtime";

const vault = process.argv[2]!;
const source = process.argv[3]!;
const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
// Idle sweeps coalesce their receipts. One pending synthetic operation with
// no port available makes continued sweep attempts observable.
db.query(`INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at)
  VALUES ('rss-probe', 'store', 'upsert', 'doc-1', 'pending', ?)`
).run("2026-01-15T10:00:00.000Z");
const baseline = process.memoryUsage().rss / (1024 * 1024);
const samples: number[] = [];
const batches: number[] = [];
let cursor: string | null = null;
let stored = 0;
const sampleBatch = () => {
  const next = getCheckpoint(db, CLAUDE_CODE_SESSIONS_CONNECTOR_ID, source)?.sync_cursor ?? null;
  if (next === null || next === cursor) return;
  cursor = next;
  const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n;
  batches.push(count - stored);
  stored = count;
  samples.push(process.memoryUsage().rss / (1024 * 1024));
};
// The drain yields to host timers after each durable batch. Observe those
// boundaries while ten batches share one pass, including its retained state.
const sampling = setInterval(sampleBatch, 1);
let clock = Date.parse("2026-01-15T10:00:00.000Z");
let passes = 0;
const now = () => new Date(clock).toISOString();
try {
  await runServeDaemon(db, vault, {
    http: false,
    process: thisProcess(now),
    shouldContinue: () => passes < 2,
    sleep: async () => { clock += 1_000; },
    acquireRuntime: async () => {
      const held = await createServeRuntime({ db, vaultPath: vault,
        store: new ConnectionStateStore(join(vault, ".kizuki")), env: process.env, err: () => {} });
      let synced = false;
      return {
        hooks: { ...held.hooks, sync: async drain => {
          synced = true;
          return held.hooks.sync!(drain);
        } },
        close: async () => {
          await held.close();
          if (synced) {
            passes++;
            sampleBatch();
            // Include the derived refresh without losing the batch sample.
            const last = samples.length - 1;
            if (last >= 0) samples[last] = Math.max(samples[last]!, process.memoryUsage().rss / (1024 * 1024));
            clock += 300_000;
          }
        },
      };
    },
  });
  console.log(JSON.stringify({ baseline, samples, batches,
    passes: listRunReceipts(db, { rail: "sync", limit: 30 }).map(receipt => ({
      has_more: receipt.has_more === true, events_stored: receipt.events_stored, errors: receipt.errors,
      started_at: receipt.started_at, finished_at: receipt.finished_at,
    })),
    stored: db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n,
    sweeps: listRunReceipts(db, { rail: "retrieval-sweep", limit: 30 }).map(receipt => receipt.started_at),
  }));
} finally { clearInterval(sampling); db.close(); }
