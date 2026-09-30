// Run the memory probe in a fresh process so earlier tests cannot warm its heap.
import { join } from "node:path";
import { ConnectionStateStore, listRunReceipts, runServeDaemon, thisProcess } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createServeRuntime } from "../../src/serve-runtime";

const vault = process.argv[2]!;
const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
const baseline = process.memoryUsage().rss / (1024 * 1024);
const samples: number[] = [];
let clock = Date.parse("2026-01-15T10:00:00.000Z");
const now = () => new Date(clock).toISOString();
try {
  await runServeDaemon(db, vault, {
    http: false,
    process: thisProcess(now),
    shouldContinue: () => samples.length < 20,
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
            // Include the derived refresh, and leave GC to the runtime.
            samples.push(process.memoryUsage().rss / (1024 * 1024));
            clock += 300_000;
          }
        },
      };
    },
  });
  console.log(JSON.stringify({ baseline, samples,
    passes: listRunReceipts(db, { rail: "sync", limit: 30 }).map(receipt => ({
      has_more: receipt.has_more === true, events_stored: receipt.events_stored, errors: receipt.errors,
    })),
    stored: db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n,
    sweeps: listRunReceipts(db, { rail: "retrieval-sweep", limit: 30 }).length,
  }));
} finally { db.close(); }
