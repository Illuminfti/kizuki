import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { initVault, readDerivedMeta, readServeEndpoint, readServeProcessMarker } from "@kizuki/core";
import { rebuildDerived } from "@kizuki/core/internal";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { storedEvent } from "../../core/test/search/helpers";
import { liveReadDaemon } from "../src/commands/daemon-read";
import { createHelpers } from "./helpers";
import { refreshDerived } from "../src/derived";

test("an idle incremental pass repairs a skipped page restored to receipted bytes", async () => {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-index-health-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    await recordedPage(db, vault, "facts/tea.md", { id: "fact:tea", type: "fact", title: "Tea", status: "active", sensitivity: "public", taint: "clean" }, "Tea with [[Kettle]].");
    refreshDerived(db, vault);
    const path = join(vault, "facts/tea.md"), original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Tea with", "Changed tea with"));
    rebuildDerived(db, vault);
    expect(readDerivedMeta(db, "search")?.skipped_count).toBe(1);
    writeFileSync(path, original);
    const pass = refreshDerived(db, vault);
    expect(pass.remaining).toBe(0);
    for (const layer of ["search", "graph"] as const) expect(readDerivedMeta(db, layer)).toMatchObject({ status: "ok", skipped_count: 0 });
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});

test("incremental refresh reconciles an upgraded watermark with durable earlier coverage", () => {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-watermark-health-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    storedEvent(db, "before-upgrade");
    expect(refreshDerived(db, vault).remaining).toBe(0);
    expect(readDerivedMeta(db, "search")?.ledger_watermark).not.toBeNull();
    db.query("UPDATE derived_meta SET ledger_watermark=NULL WHERE layer='search'").run();
    const latest = storedEvent(db, "after-upgrade");
    const cursor = db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(latest.event_id)!;
    expect(refreshDerived(db, vault)).toMatchObject({ events: 1, remaining: 0 });
    const watermark = `${cursor.accepted_at}\t${latest.event_id}`;
    expect(readDerivedMeta(db, "search")).toMatchObject({ status: "ok", ledger_watermark: watermark });
    expect(refreshDerived(db, vault)).toMatchObject({ events: 0, remaining: 0 });
    expect(readDerivedMeta(db, "search")?.ledger_watermark).toBe(watermark);
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});

test("the compiled daemon serves authenticated health before cold SQL hydration and shuts the worker down", async () => {
  const helpers = createHelpers();
  const { vault, env } = helpers.tempVault();
  const id = "kizuki.retrieval.embedded-pg";
  writeFileSync(join(vault, ".kizuki/serve.toml"), `[ports]\nretrieval = "${id}"\n`, { mode: 0o600 });
  const engine = join(vault, ".kizuki", "retrieval", id, "engine.json");
  const binary = join(helpers.tempDir(), "kizuki");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", "--define", "KIZUKI_COMPILED=true",
    join(import.meta.dir, "../src/main.ts"), "--outfile", binary], { stdout: "ignore", stderr: "pipe", timeout: 30_000 });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  const daemon = Bun.spawn([binary, "serve", "--port", "0", "--vault", vault], {
    env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore",
  });
  try {
    const deadline = performance.now() + 15_000;
    let endpoint = readServeEndpoint(vault, readServeProcessMarker(vault));
    while (endpoint === null && daemon.exitCode === null && performance.now() < deadline) {
      await Bun.sleep(10);
      endpoint = readServeEndpoint(vault, readServeProcessMarker(vault));
    }
    if (endpoint === null) throw new Error("cold daemon did not publish HTTP");
    const client = liveReadDaemon({ env, vaultOverride: vault, stdinIsTTY: false,
      stdoutIsTTY: false, stderrIsTTY: false, prompt: async () => "", out() {}, err() {} });
    if (!client) throw new Error("cold daemon read client unavailable");
    expect(await client.health()).toMatchObject({ tool: "system_health", data: { events: 0 } });
    expect(existsSync(engine)).toBe(false);
    while (!existsSync(engine) && daemon.exitCode === null && performance.now() < deadline) await Bun.sleep(20);
    expect(existsSync(engine)).toBe(true);
    const query = Bun.spawn([binary, "query", "synthetic", "--json", "--vault", vault], {
      env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore",
    });
    const output = await new Response(query.stdout).text();
    expect(await query.exited).toBe(0);
    expect(JSON.parse(output).data.hits).toEqual([]);
    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
  } finally {
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    await daemon.exited;
    helpers.cleanup();
  }
}, 30_000);
