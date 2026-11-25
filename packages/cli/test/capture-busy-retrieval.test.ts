import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { accept, count, readServeEndpoint, readServeProcessMarker, revokeSourceGrant, SERVE_TOKEN_PATH, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { EMBEDDED_RETRIEVAL_ID, openEmbeddedRetrievalPort, WriterLease } from "@kizuki/retrieval-pg";
import { validEvent } from "../../core/test/fixtures";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { liveReadDaemon } from "../src/commands/daemon-read";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);
const h = createHelpers(); afterEach(h.cleanup);

test("a live retrieval session cannot block source capture, idempotence or consent denial", async () => {
  const f = h.tempVault();
  const enrolled = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(enrolled.exitCode).toBe(0);
  const source = enrolled.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const file = join(f.vault, ".kizuki/kizuki.db"), db = openLedger(file);
  try { setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-capture", policy: {
    purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } }); } finally { db.close(); }
  const id = "kizuki.retrieval.embedded-pg";
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), `[ports]\nretrieval="${id}"\n`);
  const held = await openEmbeddedRetrievalPort({ vault_path: f.vault, data_dir: join(f.vault, ".kizuki/retrieval", id), config: {}, clock: () => new Date().toISOString(), secrets: async () => "", logger: () => {} });
  try {
    for (const args of [["backfill", "markdown-folder", "--source", source], ["sync", "markdown-folder", "--source", source], ["import", "markdown-folder", "--source", f.notes]]) {
      const result = h.runCli(f.env, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    const read = openLedger(file);
    try {
      expect(count(read)).toBe(3);
      revokeSourceGrant(read, { source_key: source, expected_revision: 1, operation_id: "fixture-deny" });
    } finally { read.close(); }
    const denied = h.runCli(f.env, "backfill", "markdown-folder", "--source", source);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("source_capture_denied");
    expect((await held.health()).status).toBe("ready");
  } finally { await held.close(); }
}, 30_000);

test("a daemon holding the retrieval writer serves CLI reads and bounded health on 12,000 records", async () => {
  const f = h.tempVault();
  const records = 12_000;
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try {
    const event = { ...validEvent(), subjects: [], attachments: [], metadata: {} };
    db.transaction(() => {
      for (let i = 1; i < records; i++) {
        accept(db, { ...event, source_record_id: `estate-${i}`, text: i === 1 ? "saffron reference" : `estate note ${i}` });
      }
      // The fixture measures serving while the daemon owns the writer, between scheduled passes.
      db.run("UPDATE schedules SET enabled=0");
    }).immediate();
    // The receipted page contributes the last event and gives the engine a trigram-only hit.
    await recordedPage(db, f.vault, "facts/orchard.md", {
      id: "fact:orchard", title: "Orchard", type: "fact", status: "active", sensitivity: "personal", taint: "clean",
    }, "The library opens after sunrise.");
    expect(count(db)).toBe(records);
  } finally { db.close(); }
  writeFileSync(join(f.vault, ".kizuki/serve.toml"),
    `[ports.retrieval]\nid = "${EMBEDDED_RETRIEVAL_ID}"\nmax_text_bytes = 16777216\n`, { mode: 0o600 });
  const rebuild = await h.runCliAsync(f.env, "rebuild", "--json");
  expect(rebuild.exitCode, rebuild.stderr).toBe(0);
  expect(JSON.parse(rebuild.stdout).data).toMatchObject({ store: EMBEDDED_RETRIEVAL_ID, documents: records + 2, floor_documents: records + 1 });

  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "serve", "--port", "0", "--vault", f.vault], {
    env: { ...process.env, ...f.env }, stdout: "ignore", stderr: "ignore",
  });
  try {
    const deadline = performance.now() + 30_000;
    while (readServeEndpoint(f.vault, readServeProcessMarker(f.vault)) === null) {
      if (daemon.exitCode !== null) throw new Error("daemon exited before publishing its endpoint");
      if (performance.now() >= deadline) throw new Error("daemon did not publish its endpoint");
      await Bun.sleep(20);
    }
    const client = liveReadDaemon({ env: f.env, vaultOverride: f.vault, stdinIsTTY: false,
      stdoutIsTTY: false, stderrIsTTY: false, out() {}, err() {}, prompt: async () => "" });
    if (!client) throw new Error("live daemon is unavailable to the read client");
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const health = await client.health();
      samples.push(performance.now() - start);
      expect(health.data).toMatchObject({ events: records });
    }
    const cold = samples[0]!;
    const p95 = samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
    expect(cold, "first authenticated health request, ms").toBeLessThan(250);
    expect(p95, "authenticated health p95, ms").toBeLessThan(250);

    const lease = new WriterLease(join(f.vault, ".kizuki/retrieval", EMBEDDED_RETRIEVAL_ID));
    expect(lease.inspect().holder?.pid).toBe(daemon.pid);
    const run = async (...args: string[]) => {
      const start = performance.now();
      const result = await h.runCliAsync(f.env, ...args, "--json");
      const ms = performance.now() - start;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(ms, `${args[0]} latency, ms`).toBeLessThan(1_500);
      return JSON.parse(result.stdout);
    };
    const query = await run("query", "saffron");
    expect(query.data.hits).toContainEqual(expect.objectContaining({ snippet: "saffron reference" }));
    expect(query.degraded).not.toContain("configured-engine-unavailable");
    expect((await run("query", "Orchrd", "--scope", "canon")).data.hits).toContainEqual(
      expect.objectContaining({ doc_id: "page:fact:orchard" }));
    expect((await run("query", "saffron", "--response-contract", "kizuki.envelope/v2")).result).toMatchObject({
      schema: "kizuki.envelope/v2", tool: "search",
    });
    const unknown = await h.runCliAsync(f.env, "query", "saffron", "--response-contract", "kizuki.envelope/v9", "--json");
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stdout)).toEqual({ schema: "kizuki.cli-result/v2", command: "query", result: {
      ok: false, error: { code: "unsupported_contract", message: "requested contract unavailable", retryable: false },
    } });
    expect((await run("world", "--operation", "find_concepts")).data.tool).toBe("world_view");
    expect((await run("memt", "recall", "saffron")).data.system2Count).toBe(1);
    expect((await run("serve", "health")).status).toBe("ok");

    // A world read could return identical data locally. Only the daemon rejects this bearer.
    writeFileSync(join(f.vault, SERVE_TOKEN_PATH), `kzs_${randomBytes(32).toString("base64url")}`, { mode: 0o600 });
    const refused = await h.runCliAsync(f.env, "world", "--operation", "find_concepts", "--json");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("authorization refused");
    expect(refused.stdout).toBe("");
  } finally {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
}, 120_000);
