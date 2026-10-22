import { afterEach, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCanonReceipts, listRunReceipts } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { putEvent, storeClaim } from "../../../core/test/canon/helpers";
import { worldFixture } from "../../../core/test/serving/world-fixture";
import { serveCommand } from "../../src/commands/serve";
import type { CliIo } from "../../src/commands";
import { createHelpers } from "../helpers";

setDefaultTimeout(30_000);
const helpers = createHelpers();
afterEach(helpers.cleanup);
function configure(vault: string, model = true) {
  const path = join(vault, ".kizuki/serve.toml");
  // An intentionally unavailable retrieval selection must not be opened by this mode.
  writeFileSync(path, '[ports]\nretrieval="kizuki.retrieval.unavailable-fixture"\n' + (model
    ? '[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="http://127.0.0.1:1/v1"\nmodel="fixture"\ntimeout_ms=1000\nmax_retries=0\n'
    : 'llm="kizuki.llm.none"\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}

test("public manual command binds the configured producer but makes no endpoint or retrieval request", async () => {
  const f = helpers.tempVault();
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try { await storeClaim(db, putEvent(db)); await worldFixture(db); } finally { db.close(); }
  configure(f.vault);
  const retrievalBefore = readdirSync(join(f.vault, ".kizuki/retrieval"), { recursive: true });
  const out: string[] = [], err: string[] = [];
  const io: CliIo = { env: f.env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: line => { out.push(line); }, err: line => { err.push(line); }, prompt: async () => "" };
  let requests = 0;
  const denyFetch: typeof globalThis.fetch = Object.assign(async () => { requests++; throw new Error("network forbidden in fixture"); }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(denyFetch);
  try {
    expect(await serveCommand.run(io, ["run", "sync", "--canon-only", "--json"])).toBe(0);
    expect(requests).toBe(0);
  } finally { fetch.mockRestore(); }
  expect(err).toEqual([]);
  const receipt = JSON.parse(out.join("\n")).data;
  expect(receipt).toMatchObject({ rail: "sync", sync_mode: "canon-only", status: "ok", canon_writes: 2,
    events_synced: 0, claims_extracted: 0, model: { calls: 0, model_ref: "kizuki.llm.openai-compatible:fixture@127.0.0.1" } });
  expect(readdirSync(join(f.vault, ".kizuki/retrieval"), { recursive: true })).toEqual(retrievalBefore);
  const again = helpers.runCli(f.env, "serve", "run", "sync", "--canon-only");
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain("rail=sync mode=canon-only status=ok");
  const check = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try { expect(listCanonReceipts(check)).toHaveLength(2); expect(listRunReceipts(check).every(r => r.sync_mode === "canon-only")).toBe(true); }
  finally { check.close(); }
});

test("model-free and invalid model configurations cannot write existing claims", async () => {
  const f = helpers.tempVault();
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try { await storeClaim(db, putEvent(db)); } finally { db.close(); }
  configure(f.vault, false);
  const result = helpers.runCli(f.env, "serve", "run", "sync", "--canon-only", "--json");
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).data).toMatchObject({ status: "failed", sync_mode: "canon-only", canon_writes: 0, model: { calls: 0 } });
  const config = join(f.vault, ".kizuki/serve.toml");
  writeFileSync(config, '[ports.llm]\nid="unknown.fixture"\n', { mode: 0o600 });
  const invalid = helpers.runCli(f.env, "serve", "run", "sync", "--canon-only", "--json");
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout).data).toMatchObject({ status: "failed", sync_mode: "canon-only", canon_writes: 0, model: { calls: 0 } });
  const check = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  try { expect(listCanonReceipts(check)).toEqual([]); } finally { check.close(); }
});

for (const args of [
  ["--canon-only"], ["--once", "--canon-only"], ["status", "--canon-only"],
  ["run", "brief", "--canon-only"], ["run", "sync", "--canon-only", "--once"],
  ["run", "sync", "--canon-only", "--install"], ["run", "sync", "--canon-only", "--port", "80"],
  ["run", "sync", "extra", "--canon-only"],
]) test(`invalid manual mode arguments ${args.join(" ")} fail before vault initialization`, () => {
  const missing = join(helpers.tempDir(), "missing-vault");
  const result = helpers.runCli(helpers.isolatedEnv(), "serve", ...args, "--vault", missing);
  expect(result.exitCode, result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("usage: kizuki serve");
  expect(existsSync(missing)).toBe(false);
});

test("help describes the explicit maintenance option without adding a scheduled rail", () => {
  const result = helpers.runCli(helpers.isolatedEnv(), "help", "serve");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("serve run sync --canon-only");
});
