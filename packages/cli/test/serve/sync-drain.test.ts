import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStateStore, runRail, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createServeRuntime } from "../../src/serve-runtime";
import { createHelpers } from "../helpers";

// Real CLI processes and durable connector batches share the host with other tests.
setDefaultTimeout(120_000);

const h = createHelpers();
afterEach(() => h.cleanup());

const BATCH = 500;

const turn = (file: number, line: number, text: string) =>
  JSON.stringify({
    type: line % 2 === 0 ? "user" : "assistant",
    uuid: `u-${file}-${line}`,
    sessionId: `s-${file}`,
    timestamp: "2026-01-15T10:00:00.000Z",
    message: { role: line % 2 === 0 ? "user" : "assistant", content: text },
  });

/** A transcript tree of `files` sessions with `turns` conversation turns each. */
function transcripts(
  root: string,
  files: number,
  turns: number,
  text: (file: number, line: number) => string,
): void {
  mkdirSync(join(root, "proj"), { recursive: true });
  for (let file = 0; file < files; file++) {
    const lines = Array.from({ length: turns }, (_, line) =>
      turn(file, line, text(file, line)),
    );
    writeFileSync(
      join(root, "proj", `s-${file}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  }
}

/** A vault with one consented Claude Code transcript source, and the ledger open on it. */
function enrolled(sessions: string, serveToml: string) {
  const setup = h.tempVault();
  writeFileSync(join(setup.vault, ".kizuki", "serve.toml"), serveToml, {
    mode: 0o600,
  });
  const connected = h.runCli(
    setup.env,
    "connect",
    "claude-code-sessions",
    "--source",
    sessions,
  );
  expect(connected.exitCode, connected.stderr).toBe(0);
  const sourceKey =
    connected.stdout.match(/source=([0-9A-HJKMNP-TV-Z]{26})/)?.[1] ?? "";
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: "drain-grant",
    policy: {
      purposes: ["capture", "recall", "session", "derive"],
      allowed_fields: ["text", "subjects", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
  const runtime = () =>
    createServeRuntime({
      db,
      vaultPath: setup.vault,
      store: new ConnectionStateStore(join(setup.vault, ".kizuki")),
      env: setup.env,
      err: () => {},
    });
  const stored = () =>
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n;
  return { setup, db, runtime, stored, sourceKey };
}

test("a first backfill drains across sync passes, one bounded slice at a time", async () => {
  const sessions = h.tempDir("kizuki-sessions-drain-");
  transcripts(
    sessions,
    2,
    251,
    (file, line) =>
      `Synthetic decision ${file}.${line}: keep the exporter stable.`,
  );
  const { setup, db, runtime, stored } = enrolled(
    sessions,
    "[serve]\nconnector_drain_batches = 1\n",
  );
  try {
    const passes = [];
    for (let pass = 0; pass < 2; pass++) {
      passes.push(
        await runRail(db, setup.vault, "sync", {
          acquireRuntime: runtime,
        }),
      );
      // The write pass and the derived refresh ran after the slice, not after the whole drain.
      expect(passes.at(-1)!.errors).toEqual([]);
    }
    // The first batch crosses into the second file; its last two turns resume next pass.
    expect(
      passes.map((receipt) => [receipt.events_stored, receipt.has_more === true]),
    ).toEqual([
      [BATCH, true],
      [2, false],
    ]);
    expect(passes.map((receipt) => receipt.events_duplicate)).toEqual([
      0, 0,
    ]);
    expect(stored()).toBe(502);
  } finally {
    db.close();
  }
});

test("a spent deadline still reads one batch per connection, and a stop request reads none", async () => {
  const sessions = h.tempDir("kizuki-sessions-drain-");
  transcripts(
    sessions,
    1,
    501,
    (file, line) =>
      `Synthetic decision ${file}.${line}: keep the exporter stable.`,
  );
  const { db, runtime, stored } = enrolled(sessions, "");
  const held = await runtime();
  try {
    const stopped = await held.hooks.sync!({
      deadline_ms: 60_000,
      max_batches: 100,
      stopRequested: () => true,
    });
    expect(stopped).toMatchObject({ has_more: true, events_stored: 0 });
    expect(stored()).toBe(0);

    const spent = await held.hooks.sync!({ deadline_ms: 0, max_batches: 100 });
    expect(spent).toMatchObject({
      has_more: true,
      events_stored: BATCH,
      errors: [],
    });
    expect(stored()).toBe(BATCH);
  } finally {
    await held.close();
    db.close();
  }
});

const MEGABYTE = 1024 * 1024;
/** Growth allowed once the heap has its working set. Retaining what the passes scan or store would cost several times this. */
const MEMORY_GROWTH_BOUND_MB = 64;
/** Includes initial heap growth before the working set has warmed. */
const TOTAL_MEMORY_GROWTH_BOUND_MB = 128;

/**
 * A tree shaped like a multi-gigabyte transcript store at test scale: many large
 * files filled with conversation turns longer than an event may be. Unlike a
 * tool-output-only fixture, every scanned turn reaches the ledger and derived
 * index, exercising the retained working set as well as the file reader.
 */
function transcriptStore(root: string, files: number, turns: number): { bytes: number } {
  mkdirSync(join(root, "proj"), { recursive: true });
  // Keep large captured payloads without making this memory probe a tokenizer
  // benchmark. The identifier is synthetic; the importer clips every turn.
  const longTurn = "Synthetic export decision: retain this artifact identifier: " +
    "synthetic".repeat(4_800) + ". Keep the exporter and importer stable.";
  // Encode the common payload once; fixture setup need not rescan gigabytes
  // through JSON.stringify. Each turn still has a distinct identity and text.
  const quotedTail = JSON.stringify(longTurn).slice(1);
  let bytes = 0;
  for (let file = 0; file < files; file++) {
    const path = join(root, "proj", `s-${file}.jsonl`);
    writeFileSync(path, "");
    for (let start = 0; start < turns; start += 100) {
      const chunk = Array.from({ length: Math.min(100, turns - start) }, (_, offset) => {
        const line = start + offset;
        const quotedHead = JSON.stringify(`${file}.${line}: `).slice(0, -1);
        return turn(file, line, "").replace(
          '"content":""', () => `"content":${quotedHead}${quotedTail}`,
        );
      }).join("\n") + "\n";
      appendFileSync(path, chunk);
      bytes += Buffer.byteLength(chunk);
    }
  }
  return { bytes };
}

test("the real serve loop keeps RSS bounded across twenty session batches", async () => {
  const sessions = h.tempDir("kizuki-sessions-drain-");
  const { bytes } = transcriptStore(sessions, 200, 260);
  expect(bytes).toBeGreaterThan(2_048 * MEGABYTE);
  const { setup, db, sourceKey } = enrolled(sessions, "[serve]\nconnector_drain_batches = 10\nsync_period_s = 60\n");
  db.close();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "sync-drain-memory-child.ts"), setup.vault, sourceKey], {
    env: { ...process.env, ...setup.env }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const { baseline, samples, batches, passes, stored, sweeps } = JSON.parse(stdout) as {
      baseline: number; samples: number[]; batches: number[]; passes: {
        has_more: boolean; events_stored: number; errors: string[]; started_at: string; finished_at: string;
      }[];
      stored: number; sweeps: string[];
    };
    expect(samples).toHaveLength(20);
    expect(batches).toHaveLength(20);
    expect(batches.every(count => count >= 50)).toBe(true);
    expect(passes).toHaveLength(2);
    expect(passes.every(receipt => receipt.has_more && receipt.errors.length === 0)).toBe(true);
    expect(stored).toBe(passes.reduce((sum, receipt) => sum + receipt.events_stored, 0));
    expect(stored).toBe(batches.reduce((sum, count) => sum + count, 0));
    expect(stored).toBeGreaterThanOrEqual(1_000);
    // A pending synthetic operation keeps sweeps observable. Prove their
    // schedule by their position between the two sync passes.
    expect(sweeps.some(at => at >= passes[0]!.finished_at && at <= passes[1]!.started_at)).toBe(true);
    expect(Math.max(...samples) - baseline, `baseline ${baseline} MB; rss samples ${samples.map(Math.round).join(" ")}`)
      .toBeLessThan(TOTAL_MEMORY_GROWTH_BOUND_MB);
    const warm = Math.max(...samples.slice(2, 5));
    const growth = Math.max(...samples.slice(5)) - warm;
    expect(growth, `rss in MB after each batch: ${samples.map(Math.round).join(" ")}`).toBeLessThan(MEMORY_GROWTH_BOUND_MB);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 120_000);
