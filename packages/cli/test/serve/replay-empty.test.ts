import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@kizuki/core";
import { replayFixture } from "../../../core/test/serve/extract-replay-fixture";
import { serveCommand } from "../../src/commands/serve";
import { readEmptyReplayPlan } from "../../src/empty-replay-plan";
import type { CliIo } from "../../src/commands";
import { createHelpers } from "../helpers";

const helpers = createHelpers(), fixtures: ReturnType<typeof replayFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); helpers.cleanup(); });
function fixture() { const f = replayFixture(); fixtures.push(f); return f; }
function planFile(f: ReturnType<typeof fixture>) {
  const path = join(f.root, "reviewed-plan.json"), bytes = JSON.stringify(f.plan);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, bytes, digest: sha256Hex(bytes) };
}

test("public CLI binds the actual configured producer and applies only metadata without model or retrieval calls", async () => {
  const f = fixture(), plan = planFile(f), env = helpers.isolatedEnv();
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.unavailable-fixture"\n[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="https://models.example.test/v1"\nmodel="fixture-throughput-model"\n', { mode: 0o600 });
  const out: string[] = [], err: string[] = [];
  const io: CliIo = { env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: line => { out.push(line); }, err: line => { err.push(line); }, prompt: async () => "" };
  let requests = 0;
  const denyFetch: typeof globalThis.fetch = Object.assign(async () => { requests++; throw new Error("fixture forbids network"); }, { preconnect: globalThis.fetch.preconnect });
  const observed = spyOn(globalThis, "fetch").mockImplementation(denyFetch);
  try {
    expect(await serveCommand.run(io, ["replay-empty", "--plan", plan.path, "--plan-sha256", plan.digest, "--json"])).toBe(0);
    expect(requests).toBe(0);
  } finally { observed.mockRestore(); }
  expect(err).toEqual([]);
  expect(JSON.parse(out.join("\n")).data).toMatchObject({ status: "accepted", end_utf16: f.plan.segment.done_utf16 });
  const repeated = helpers.runCli(env, "serve", "replay-empty", "--plan", plan.path, "--plan-sha256", plan.digest, "--json", "--vault", f.vault);
  expect(repeated.exitCode, repeated.stderr).toBe(0);
  expect(JSON.parse(repeated.stdout).data.status).toBe("already_applied");
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
  expect(f.db.query("SELECT * FROM claims").all()).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("private plan reading binds identical bytes and refuses links, modes, wrong digest and unbounded or extra fields", () => {
  const f = fixture(), plan = planFile(f);
  expect(readEmptyReplayPlan(plan.path, plan.digest)).toEqual(f.plan);
  expect(() => readEmptyReplayPlan(plan.path, "0".repeat(64))).toThrow("invalid_plan");
  const link = join(f.root, "plan-link"); symlinkSync(plan.path, link);
  expect(() => readEmptyReplayPlan(link, plan.digest)).toThrow("invalid_plan");
  chmodSync(plan.path, 0o644);
  expect(() => readEmptyReplayPlan(plan.path, plan.digest)).toThrow("invalid_plan");
  chmodSync(plan.path, 0o600);
  const extra = JSON.stringify({ ...f.plan, source_text: "synthetic text must not be echoed" });
  writeFileSync(plan.path, extra);
  expect(() => readEmptyReplayPlan(plan.path, sha256Hex(extra))).toThrow("invalid_plan");
  writeFileSync(plan.path, "x".repeat(16385));
  expect(() => readEmptyReplayPlan(plan.path, sha256Hex("x".repeat(16385)))).toThrow("invalid_plan");
  writeFileSync(plan.path, plan.bytes);
  linkSync(plan.path, join(f.root, "hardlink"));
  expect(() => readEmptyReplayPlan(plan.path, plan.digest)).toThrow("invalid_plan");
});

test("missing configured model refuses a valid plan without resetting progress", () => {
  const f = fixture(), plan = planFile(f);
  const result = helpers.runCli(helpers.isolatedEnv(), "serve", "replay-empty", "--plan", plan.path, "--plan-sha256", plan.digest, "--vault", f.vault);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("producer_changed");
  expect(f.db.query("SELECT done_utf16 FROM extract_oversized_records").get()).toEqual({ done_utf16: f.plan.segment.done_utf16 });
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toEqual([]);
});

for (const args of [
  ["replay-empty"], ["replay-empty", "--once"], ["run", "sync", "--plan", "unused"],
  ["replay-empty", "extra", "--plan", "unused", "--plan-sha256", "0".repeat(64)],
  ["replay-empty", "--plan", "unused", "--plan-sha256", "0".repeat(64), "--canon-only"],
]) test(`invalid replay arguments ${args.slice(0, 2).join(" ")} fail before opening a vault`, () => {
  const missing = join(helpers.tempDir(), "missing");
  const result = helpers.runCli(helpers.isolatedEnv(), "serve", ...args, "--vault", missing);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(existsSync(missing)).toBe(false);
});
