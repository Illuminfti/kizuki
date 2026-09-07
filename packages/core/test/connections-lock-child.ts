import { existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { listConnections } from "../src/ledger/connections";
import { enrollConnection } from "../src/ledger/enroll";
import { connector, io } from "./connections-helpers";

const [control, mode] = process.argv.slice(2);
if (!control || !mode) throw Error("synthetic fixture arguments missing");
if (mode === "paused-timed-out") {
  const deadline = await import("../src/util/deadline");
  const actualDeadline = deadline.withDeadline;
  mock.module(join(import.meta.dir, "../src/util/deadline.ts"), () => ({ ...deadline,
    withDeadline: <T>(work: Promise<T>, _milliseconds: number, message: string) => actualDeadline(work, 10, message),
  }));
}
const db = openLedger(join(control, "ledger.sqlite"));
const store = new ConnectionStateStore(control);
let entered = 0;
let settled!: () => void;
const providerSettled = new Promise<void>(resolve => { settled = resolve; });
const provider = connector(async (_io, writer) => {
  try {
    entered++;
    if (["paused-stage", "paused-fresh-stage", "paused-timed-out", "paused-caught-write"].includes(mode)) {
      await writer.write(new TextEncoder().encode("synthetic winner state"));
      if (mode === "paused-stage") {
        const old = new Date(Date.now() - 3_600_000);
        for (const name of readdirSync(store.directory).filter(name => name.endsWith(".tmp"))) utimesSync(join(store.directory, name), old, old);
      }
    }
    if (mode === "paused-caught-write") {
      try { await writer.write(new TextEncoder().encode("synthetic forbidden duplicate")); }
      catch { /* The provider continues after its one-shot writer was refused. */ }
    }
    if (mode.startsWith("paused-")) {
      if (mode !== "paused-timed-out") process.stdout.write(JSON.stringify({ phase: "paused", entered }) + "\n");
      const action = (await Bun.stdin.text()).trim();
      if (action === "abort") throw Error("synthetic provider cancellation");
    }
    if (mode === "paused-timed-out") {
      let refused = false;
      try { await writer.write(new TextEncoder().encode("synthetic late state")); } catch { refused = true; }
      if (!refused) throw Error("late writer remained active");
    } else if (!["paused-stage", "paused-fresh-stage", "paused-caught-write"].includes(mode)) {
      await writer.write(new TextEncoder().encode("synthetic replacement state"));
    }
    return { display: "synthetic provider" };
  } finally { settled(); }
});
try {
  if (mode === "recover") store.recover(db);
  else if (mode === "enroll") await enrollConnection(db, store, provider, io);
  else {
    const current = listConnections(db, { includeDisconnected: true })[0];
    if (!current) throw Error("synthetic fixture row missing");
    await store.replace(db, current, provider, io);
  }
  process.stdout.write(JSON.stringify({ ok: true, entered }) + "\n");
} catch (error) {
  if (mode === "paused-timed-out") {
    if (!(error instanceof Error) || error.message !== "sign-in timed out") throw error;
    process.stdout.write(JSON.stringify({ phase: "paused", timed_out: true, entered }) + "\n");
    await providerSettled;
    await Bun.sleep(0);
    process.stdout.write(JSON.stringify({ phase: "settled", entered }) + "\n");
    while (!existsSync(join(control, "synthetic-settled-exit"))) await Bun.sleep(5);
  }
  process.stdout.write(JSON.stringify({ ok: false, entered, error: error instanceof Error ? error.message : "unknown" }) + "\n");
} finally { db.close(); }
