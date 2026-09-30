import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  listConnections,
  getCheckpoint,
  listRunReceipts,
  pidAlive,
  readBootId,
  readLease,
  readRunReceiptsLog,
  setSourceGrant,
} from "@kizuki/core";
import type { RunReceipt } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { acquireLease } from "../../../core/src/serve/leases";
import { INGEST_LEASE } from "../../../core/src/serve/lease-held";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers, fixtureConsent } from "../helpers";

// These tests run a real daemon beside a real second writer.
setDefaultTimeout(120_000);

const { cleanup, runCli, runCliAsync, tempVault } = createHelpers();
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  const running = children.splice(0);
  for (const child of running) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(running.map(child => child.exited));
  cleanup();
});

const main = resolve(import.meta.dir, "../../src/main.ts");
const HOLDER = resolve(
  import.meta.dir,
  "../../../core/test/ledger-busy-child.ts",
);
const MODEL = "synthetic/stop-model";

type Setup = ReturnType<typeof tempVault>;

function startDaemon(setup: Setup, ...extra: string[]) {
  const daemon = Bun.spawn(
    [
      process.execPath,
      main,
      "serve",
      "--no-http",
      "--vault",
      setup.vault,
      ...extra,
    ],
    {
      env: { ...process.env, ...setup.env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(daemon);
  return daemon;
}

async function until<T>(
  what: string,
  ms: number,
  probe: () => T | null | undefined | false,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const ledger = (setup: Setup): string =>
  join(setup.vault, ".kizuki", "kizuki.db");

function readLedger<T>(
  setup: Setup,
  read: (db: ReturnType<typeof openLedger>) => T,
): T {
  const db = openLedger(ledger(setup));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

async function holdLedger(setup: Setup, holdMs: number) {
  const child = Bun.spawn(
    [process.execPath, HOLDER, ledger(setup), String(holdMs)],
    { stdout: "pipe", stderr: "pipe" },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(buffered.split("\n")[0]).toBe("held");
  return child;
}

/** Record this test process as the running ingest, the way a long CLI writer does, so the holder has a name. */
function recordIngestHolder(setup: Setup): void {
  readLedger(setup, (db) => {
    const holder = {
      pid: process.pid,
      boot_id: readBootId(),
      now: () => new Date().toISOString(),
      isAlive: pidAlive,
    };
    expect(acquireLease(db, holder, INGEST_LEASE).acquired).toBe(true);
  });
}

test("a daemon outlives a writer that holds the ledger past every wait, skips the passes it meets with a typed receipt naming the holder, and resumes", async () => {
  const setup = tempVault();
  const daemon = startDaemon(setup);
  // The first pass of every rail runs at start.
  await until(
    "the first pass of every rail",
    60_000,
    () => readLedger(setup, (db) => listRunReceipts(db).length >= 7) || null,
  );
  recordIngestHolder(setup);
  // Make every rail due while the writer holds the ledger.
  readLedger(setup, (db) =>
    db
      .query("UPDATE schedules SET next_run_at = ?")
      .run(new Date(Date.now() + 5_000).toISOString()),
  );
  const holder = await holdLedger(setup, 14_000);
  const held = await until(
    "a skipped pass in the receipt journal",
    30_000,
    () =>
      readRunReceiptsLog(setup.vault).find(
        (receipt: RunReceipt) => receipt.stopped === "ledger:lease_held",
      ) ?? null,
  );
  expect(held).toMatchObject({
    status: "stopped",
    stopped: "ledger:lease_held",
  });
  expect(held.errors[0]).toContain(
    `a running kizuki ingest (pid ${process.pid})`,
  );
  expect(held.errors[0]).toContain("retries with backoff");
  // The writer outlasts several probes and backoffs; the daemon stays up.
  await holder.exited;
  expect(daemon.exitCode).toBeNull();
  const skipped = readRunReceiptsLog(setup.vault).filter(
    (receipt: RunReceipt) => receipt.stopped === "ledger:lease_held",
  );
  expect(skipped.length).toBeGreaterThanOrEqual(2);
  // Once the writer lets go, the journal reaches the ledger and every rail runs again.
  await until(
    "the skipped passes in the ledger and every rail current",
    60_000,
    () =>
      readLedger(setup, (db) => {
        const rows = db
          .query<{ next_run_at: string }, []>(
            "SELECT next_run_at FROM schedules",
          )
          .all();
        const skippedRows = listRunReceipts(db).filter(
          (receipt) => receipt.stopped === "ledger:lease_held",
        );
        return (
          skippedRows.length >= 1 &&
          rows.every((row) => row.next_run_at > new Date().toISOString())
        );
      }) || null,
  );
  expect(daemon.exitCode).toBeNull();
  const stop = await runCliAsync(
    setup.env,
    "serve",
    "stop",
    "--vault",
    setup.vault,
  );
  expect(stop.exitCode, stop.stderr).toBe(0);
  expect(await daemon.exited).toBe(0);
  const journal = await new Response(daemon.stderr).text();
  expect(journal).toContain('"event":"ledger_held"');
  expect(journal).toContain('"event":"ledger_free"');
  expect(journal).not.toContain("lease_held: another kizuki process");
});

test("an import beside a running daemon completes, records itself as the holder while it runs, and leaves no record", async () => {
  const setup = tempVault();
  const daemon = startDaemon(setup);
  await until("the daemon", 30_000, () => existsSync(join(setup.vault, ".kizuki", "serve.pid")) || null);
  const beat = () => readLedger(setup, db => readLease(db, "writer")?.heartbeat_at ?? null);
  const before = beat();
  const imported = await runCliAsync(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root));
  expect(imported.exitCode, imported.stderr).toBe(0);
  expect(imported.stdout).toContain("stored=3");
  expect(imported.stderr).not.toContain("lease_held");
  // The daemon kept its own lease fresh while the import ran, and never left.
  await until("the daemon's next heartbeat", 10_000, () => beat()! > before! || null);
  expect(daemon.exitCode).toBeNull();
  expect(readLedger(setup, db => readLease(db, INGEST_LEASE))).toBeNull();
  const stop = await runCliAsync(setup.env, "serve", "stop", "--vault", setup.vault);
  expect(stop.exitCode, stop.stderr).toBe(0);
  expect(await daemon.exited).toBe(0);
});

for (const stopMode of ["SIGTERM", "serve stop"] as const) {
  test(`${stopMode} exits without restarting while a writer holds the ledger beyond TimeoutStopSec`, async () => {
    const setup = tempVault();
    const daemon = startDaemon(setup);
    await until("the first pass of every rail", 60_000,
      () => readLedger(setup, db => listRunReceipts(db).length >= 7) || null);
    const holder = await holdLedger(setup, 100_000);
    const started = Date.now();
    if (stopMode === "SIGTERM") daemon.kill("SIGTERM");
    else {
      const stop = await runCliAsync(setup.env, "serve", "stop", "--vault", setup.vault);
      expect(stop.exitCode, stop.stderr).toBe(0);
    }
    const exit = await Promise.race([daemon.exited, Bun.sleep(40_000).then(() => "timeout")]);
    expect(exit).toBe(0);
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(holder.exitCode).toBeNull();
    expect(existsSync(join(setup.vault, ".kizuki", "serve.pid"))).toBe(false);
    const output = await new Response(daemon.stderr).text();
    expect(output).not.toContain('"event":"start_held"');
    holder.kill("SIGKILL");
    await holder.exited;
  });
}

test("a daemon started while the ledger is held waits and starts, instead of exiting into the supervisor's start limit", async () => {
  const setup = tempVault();
  // Longer than every bounded wait the ledger has, so the first start is refused.
  const holder = await holdLedger(setup, 34_000);
  const daemon = startDaemon(setup);
  const line = await until("the daemon to say it is waiting", 60_000, () => {
    const marker = existsSync(join(setup.vault, ".kizuki", "serve.pid"));
    return marker ? "started" : daemon.exitCode !== null ? "exited" : null;
  });
  // It only starts once the writer has gone.
  expect(line).toBe("started");
  expect(holder.exitCode).not.toBeNull();
  expect(daemon.exitCode).toBeNull();
  const stop = await runCliAsync(
    setup.env,
    "serve",
    "stop",
    "--vault",
    setup.vault,
  );
  expect(stop.exitCode, stop.stderr).toBe(0);
  expect(await daemon.exited).toBe(0);
  const journal = await new Response(daemon.stderr).text();
  expect(journal).toContain('"event":"start_held"');
});

test("SIGTERM cancels startup retries while the ledger remains held", async () => {
  const setup = tempVault();
  const holder = await holdLedger(setup, 100_000);
  const daemon = startDaemon(setup);
  let output = "";
  const drain = (async () => {
    const reader = daemon.stderr.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output += new TextDecoder().decode(chunk.value);
      }
    } finally { reader.releaseLock(); }
  })();
  await until("startup backoff", 60_000, () => output.includes('"event":"start_held"') || null);
  daemon.kill("SIGTERM");
  expect(await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(0);
  await drain;
  expect(holder.exitCode).toBeNull();
  expect(existsSync(join(setup.vault, ".kizuki", "serve.pid"))).toBe(false);
  expect(output.match(/"event":"start_held"/g)).toHaveLength(1);
  holder.kill("SIGKILL");
  await holder.exited;
});

async function daemonInsideModelRequest(setup: Setup) {
  const notes = join(setup.root, "stop-notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "a.md"), "Ada joined the orchard library project.");
  // The model never answers, and its own timeout is the longest the config allows.
  const endpoint = startFakeEndpoint(async () => {
    await Bun.sleep(120_000);
    return new Response("late", { status: 500 });
  });
  expect(
    runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode,
  ).toBe(1);
  readLedger(setup, (db) => {
    const source = listConnections(db).find(
      (item) => item.connector_id === "kizuki.markdown-folder",
    )!;
    setSourceGrant(db, {
      source_key: source.source_key,
      expected_revision: 0,
      operation_id: "fixture-stop-grant",
      policy: {
        purposes: ["capture", "recall", "session", "derive", "extract"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: {
          model_endpoint: `${endpoint.base_url}/chat/completions`,
          model: MODEL,
          external_retention: "provider_managed",
        },
        sensitivity_floor: "public",
      },
    });
  });
  expect(
    runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode,
  ).toBe(0);
  const toml = join(setup.vault, ".kizuki/serve.toml");
  writeFileSync(
    toml,
    [
      "[serve]",
      "sync_period_s = 120",
      "[extraction]",
      "max_calls_per_pass = 3",
      "records_per_request = 1",
      "[ports.llm]",
      'id = "kizuki.llm.openai-compatible"',
      `base_url = "${endpoint.base_url}"`,
      `model = "${MODEL}"`,
      "max_retries = 0",
      "timeout_ms = 600000",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(toml, 0o600);
  const daemon = startDaemon(setup);
  await until(
    "a request in flight at the model",
    60_000,
    () => endpoint.requests.length > 0 || null,
  );
  return { daemon, endpoint };
}

function expectStoppedByRequest(setup: Setup): void {
  const sync = readLedger(setup, (db) =>
    listRunReceipts(db).find((receipt) => receipt.rail === "sync"),
  )!;
  expect(sync).toMatchObject({
    status: "stopped",
    stopped: "serve:stop_requested",
  });
  // The daemon's own stop is charged as a call but is not the model failing.
  expect(sync.model.unavailable).toBe(0);
  expect(sync.model.diagnostic).toBeUndefined();
  expect(sync.errors).toEqual([]);
}

test("SIGTERM during a model request aborts it: the pass stops as serve:stop_requested and the process exits at once", async () => {
  const setup = tempVault();
  const { daemon, endpoint } = await daemonInsideModelRequest(setup);
  try {
    const started = Date.now();
    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
    // Far inside the unit's TimeoutStopSec, and nowhere near the model's ten-minute timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    expectStoppedByRequest(setup);
    expect(existsSync(join(setup.vault, ".kizuki", "serve.pid"))).toBe(false);
  } finally {
    endpoint.stop();
  }
});

test("kizuki serve stop during a model request aborts it too", async () => {
  const setup = tempVault();
  const { daemon, endpoint } = await daemonInsideModelRequest(setup);
  try {
    const started = Date.now();
    const stop = await runCliAsync(
      setup.env,
      "serve",
      "stop",
      "--vault",
      setup.vault,
    );
    expect(stop.exitCode, stop.stderr).toBe(0);
    expect(await daemon.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expectStoppedByRequest(setup);
  } finally {
    endpoint.stop();
  }
});

test("SIGTERM during connector draining commits only the batch in flight and a restart resumes the remaining batches and sources", async () => {
  const fixture = tempVault();
  const setup = { ...fixture, env: { ...fixture.env, BEEPER_TOKEN: "synthetic-drain-token" } };
  let draining = false;
  const batches: number[] = [];
  let finishBatch!: () => void;
  const currentBatch = new Promise<void>(resolve => { finishBatch = resolve; });
  const endpoint = startFakeEndpoint(async request => {
    if (request.path === "/v1/info") {
      return Response.json({ app: { name: "Beeper", version: "fixture" }, server: { status: "running" } });
    }
    if (request.path !== "/v1/messages/search") return new Response("not found", { status: 404 });
    const index = draining ? Number(new URLSearchParams(request.search).get("cursor") ?? "0") + 1 : 0;
    if (draining) batches.push(index);
    if (index === 1) await currentBatch;
    return Response.json({
      items: [{ id: `fixture-${index}`, accountID: "fixture-account", chatID: "fixture-chat",
        senderID: "fixture-sender", sortKey: String(index), timestamp: `2026-09-04T10:00:0${index}Z`, text: "A synthetic library update." }],
      hasMore: draining && index < 3, oldestCursor: String(index), newestCursor: String(index),
    });
  });
  try {
    const connected = await runCliAsync(setup.env, "connect", "beeper", "--token-ref", "env:BEEPER_TOKEN",
      "--endpoint", endpoint.origin);
    expect(connected.exitCode, connected.stderr).toBe(0);
    const source = readLedger(setup, db => listConnections(db).find(item => item.connector_id === "kizuki.beeper")!);
    readLedger(setup, db => setSourceGrant(db, {
      source_key: source.source_key, expected_revision: 0, operation_id: "fixture-drain-grant",
      policy: { purposes: ["capture", "recall", "session", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
        egress: "local_only", sensitivity_floor: "public" },
    }));
    const initial = await runCliAsync(setup.env, "sync", "beeper");
    expect(initial.exitCode, initial.stderr).toBe(0);
    const otherSource = await runCliAsync(setup.env, "connect", "markdown-folder", "--source", setup.notes);
    expect(otherSource.exitCode, otherSource.stderr).toBe(0);
    readLedger(setup, db => setSourceGrant(db, {
      source_key: listConnections(db).find(item => item.connector_id === "kizuki.markdown-folder")!.source_key,
      expected_revision: 0, operation_id: "fixture-second-source-grant",
      policy: { purposes: ["capture", "recall", "session", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
        egress: "local_only", sensitivity_floor: "public" },
    }));
    draining = true;
    const daemon = startDaemon(setup);
    await until("the first connector batch in flight", 60_000, () => batches.length === 1 || null);
    daemon.kill("SIGTERM");
    // Deliver the signal before the current bounded provider operation finishes.
    await Bun.sleep(100);
    finishBatch();
    expect(await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(0);
    expect(batches).toEqual([1]);
    const receipt = readLedger(setup, db => listRunReceipts(db, { rail: "sync" }).at(-1))!;
    expect(receipt).toMatchObject({ stopped: "serve:stop_requested", status: "stopped", events_stored: 1, errors: [] });
    const checkpoint = readLedger(setup, db => getCheckpoint(db, "kizuki.beeper", source.source_key))!;
    expect(JSON.parse(checkpoint.sync_cursor!).after).toBe("1");
    expect(readLedger(setup, db => db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.markdown-folder'").get()!.n)).toBe(0);
    // The next pass starts from the committed batch, then reaches the later source.
    readLedger(setup, db => db.query("UPDATE schedules SET next_run_at=NULL WHERE rail='sync'").run());
    const restarted = startDaemon(setup);
    await until("remaining batches and the second source", 60_000, () =>
      batches.length === 3 && readLedger(setup, db =>
        db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.markdown-folder'").get()!.n) === 3 || null);
    expect(batches).toEqual([1, 2, 3]);
    const stop = await runCliAsync(setup.env, "serve", "stop", "--vault", setup.vault);
    expect(stop.exitCode, stop.stderr).toBe(0);
    expect(await restarted.exited).toBe(0);
  } finally { finishBatch(); endpoint.stop(); }
});
