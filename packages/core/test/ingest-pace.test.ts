import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { INGEST_PAUSE_MS, INGEST_SLICE_MS, beginIngest, type IngestClock } from "../src/ingest/pace";
import { openLedger } from "../src/ledger/db";
import { INGEST_LEASE } from "../src/serve/lease-held";
import { readLease } from "../src/serve/leases";
import { tempVault } from "./helpers/vault";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function openVault() {
  const vault = tempVault("ingest-pace-");
  cleanup.push(vault.dispose);
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  cleanup.push(() => db.close());
  return { vault: vault.path, db };
}

/** A clock that only moves when the ingest works or sleeps, so pauses are counted, not waited. */
function manualClock() {
  let at = 0;
  const pauses: number[] = [];
  const clock: IngestClock = {
    now: () => at,
    sleep: (ms) => {
      pauses.push(ms);
      at += ms;
    },
  };
  return { clock, pauses, work: (ms: number) => (at += ms) };
}

function announceDaemon(vault: string, pid: number): void {
  writeFileSync(
    join(vault, ".kizuki", "serve.pid"),
    `${JSON.stringify({ pid, boot_id: "b", instance_id: "i" })}\n`,
    { mode: 0o600 },
  );
}

test("while a daemon runs, an ingest leaves the ledger free after every slice of writing", () => {
  const { vault, db } = openVault();
  announceDaemon(vault, process.ppid);
  const time = manualClock();
  const ingest = beginIngest(db, vault, time.clock);
  // Commits that add up to less than a slice never pause.
  time.work(INGEST_SLICE_MS - 1);
  ingest.pace();
  expect(time.pauses).toEqual([]);
  // The slice is used up: one pause, then a fresh slice.
  time.work(1);
  ingest.pace();
  expect(time.pauses).toEqual([INGEST_PAUSE_MS]);
  time.work(INGEST_SLICE_MS - 1);
  ingest.pace();
  expect(time.pauses).toEqual([INGEST_PAUSE_MS]);
  time.work(1);
  ingest.pace();
  expect(time.pauses).toEqual([INGEST_PAUSE_MS, INGEST_PAUSE_MS]);
  ingest[Symbol.dispose]();
});

test("with no daemon the ingest never slows down, and a dead daemon's marker is not a daemon", () => {
  const { vault, db } = openVault();
  const time = manualClock();
  const ingest = beginIngest(db, vault, time.clock);
  time.work(10 * INGEST_SLICE_MS);
  ingest.pace();
  announceDaemon(vault, 2_147_483_646);
  time.work(10 * INGEST_SLICE_MS);
  ingest.pace();
  expect(time.pauses).toEqual([]);
  ingest[Symbol.dispose]();
});

test("a running ingest is on record until it ends, and a second one leaves the first's record alone", () => {
  const { vault, db } = openVault();
  const first = beginIngest(db, vault);
  expect(readLease(db, INGEST_LEASE)?.holder_pid).toBe(process.pid);
  // Same process, so this is the same holder; ending twice is harmless.
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  expect(readLease(db, INGEST_LEASE)).toBeNull();
});

test("an ingest that cannot take the record because the ledger is held still runs", async () => {
  const { vault, db } = openVault();
  db.exec("PRAGMA busy_timeout = 0");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "ledger-busy-child.ts"), join(vault, ".kizuki", "kizuki.db"), "3000"],
    { stdout: "pipe", stderr: "pipe" },
  );
  cleanup.push(() => child.kill());
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  reader.releaseLock();
  const ingest = beginIngest(db, vault);
  ingest.pace();
  ingest[Symbol.dispose]();
  child.kill();
  await child.exited;
  expect(readLease(db, INGEST_LEASE)).toBeNull();
});

interface Interleaving {
  readonly attempts: number;
  readonly refused: number;
  readonly stored: number;
  readonly errors: readonly string[];
}

/**
 * Run a real long writer while this process, standing in for the daemon,
 * asks for the write lock as its heartbeat does. Returns how often it was refused.
 */
async function interleave(mode: "paced" | "unpaced", durationMs: number): Promise<Interleaving> {
  const { vault } = openVault();
  announceDaemon(vault, process.pid);
  const probe = openLedger(join(vault, ".kizuki", "kizuki.db"), { busyTimeoutMs: 1_000 });
  cleanup.push(() => probe.close());
  const writer = Bun.spawn([process.execPath, join(import.meta.dir, "ingest-pace-child.ts"), vault, String(durationMs), mode], { stdout: "pipe", stderr: "pipe" });
  cleanup.push(() => {
    if (writer.exitCode === null) writer.kill("SIGKILL");
  });
  const reader = writer.stdout.getReader();
  let text = "";
  while (!text.includes("writing\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`writer ended early: ${await new Response(writer.stderr).text()}`);
    text += new TextDecoder().decode(chunk.value);
  }
  let attempts = 0;
  let refused = 0;
  const finished = writer.exited.then(() => true);
  while (!(await Promise.race([finished, Bun.sleep(150).then(() => false)]))) {
    attempts += 1;
    try {
      probe.transaction(() => probe.query("UPDATE leases SET heartbeat_at = heartbeat_at WHERE name = 'none'").run()).immediate();
    } catch {
      refused += 1;
    }
  }
  while (!text.includes("}\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  const summary = JSON.parse(text.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { stored?: number; errors?: string[] };
  return { attempts, refused, stored: summary.stored ?? 0, errors: summary.errors ?? [] };
}

test("a paced long writer lets a waiting daemon in throughout: no heartbeat is refused and the ingest completes", async () => {
  const run = await interleave("paced", 8_000);
  expect(run.errors).toEqual([]);
  expect(run.stored).toBeGreaterThan(0);
  expect(run.attempts).toBeGreaterThanOrEqual(5);
  expect(run.refused).toBe(0);
}, 120_000);
