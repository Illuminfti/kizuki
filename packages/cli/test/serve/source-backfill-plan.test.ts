import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sha256Hex } from "@kizuki/core";
import { readSourceBackfillPlan } from "../../src/empty-replay-plan";
import { serveCommand } from "../../src/commands/serve";
import type { CliIo } from "../../src/commands";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/tmp/kizuki-backfill-plan-"); roots.push(root);
  const plan = { schema: "kizuki.source-prefix-backfill/v1" as const, operation_id: "synthetic-plan", vault_id: "synthetic-vault",
    event_id: "01J00000000000000000000000", connector_id: "fixture", source_key: "fixture-source", content_hash: "a".repeat(64), text_hash: "b".repeat(64),
    source_revision: 1, source_policy_digest: "c".repeat(64), source_epoch: 1, producer_fingerprint: "d".repeat(64), model_binding_digest: "e".repeat(64),
    window: { start_utf16: 0, end_utf16: 100, cap_utf16: 512 }, inventory_sha256: "f".repeat(64), state_sha256: "0".repeat(64),
    run_receipts: [{ run_id: "synthetic-run", sha256: "1".repeat(64) }], review: { compatible_prior_claims_sha256: "2".repeat(64), qualification_sha256: "3".repeat(64), producer_review_sha256: "4".repeat(64) },
    budget: { max_input_tokens: 8000, max_output_tokens: 8192, input_token_overhead: 0 }, predecessor: null };
  const bytes = JSON.stringify(plan), path = join(root, "plan.json"); writeFileSync(path, bytes, { mode: 0o600 });
  return { root, plan, path, digest: sha256Hex(bytes) };
}
test("backfill plan reader uses identical private bytes and refuses links, modes, digest mismatch and extra source text", () => {
  const f = fixture(); expect(readSourceBackfillPlan(f.path, f.digest)).toEqual(f.plan);
  expect(() => readSourceBackfillPlan(f.path, "0".repeat(64))).toThrow("invalid_plan");
  const link = join(f.root, "link"); symlinkSync(f.path, link); expect(() => readSourceBackfillPlan(link, f.digest)).toThrow("invalid_plan");
  chmodSync(f.path, 0o644); expect(() => readSourceBackfillPlan(f.path, f.digest)).toThrow("invalid_plan"); chmodSync(f.path, 0o600);
  const extra = JSON.stringify({ ...f.plan, source_text: "synthetic content must not be accepted or echoed" }); writeFileSync(f.path, extra);
  expect(() => readSourceBackfillPlan(f.path, sha256Hex(extra))).toThrow("invalid_plan");
  writeFileSync(f.path, JSON.stringify(f.plan)); linkSync(f.path, join(f.root, "hardlink")); expect(() => readSourceBackfillPlan(f.path, f.digest)).toThrow("invalid_plan");
});
test("backfill CLI requires one exact plan and disallows run, daemon and canon flags", async () => {
  const io: CliIo = { env: {}, vaultOverride: "/nonexistent/synthetic-vault", stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: () => { throw new Error("no output before valid arguments"); }, err: () => {}, prompt: async () => "" };
  for (const args of [["backfill-source"], ["backfill-source", "--once"], ["backfill-source", "extra", "--plan", "/absent", "--plan-sha256", "0".repeat(64)],
    ["backfill-source", "--plan", "/absent", "--plan-sha256", "0".repeat(64), "--canon-only"]])
    await expect(serveCommand.run(io, args)).rejects.toThrow("serve");
});

test("configured CLI makes one synthetic call, settles only additive meaning, and finishes canon separately", async () => {
  const { execFileSync } = await import("node:child_process");
  const { spyOn } = await import("bun:test");
  const { sourceBackfillFixture, response } = await import("../../../core/test/serve/source-backfill-fixture");
  const { modelQuoteWire } = await import("../../../core/test/producer/quote-wire-helper");
  const { inspectCanonRecovery } = await import("@kizuki/core");
  const parent = mkdtempSync(join(homedir(), "kizuki-backfill-cli-")); chmodSync(parent, 0o700);
  execFileSync("git", ["init", "--quiet", parent]);
  const previous = process.env.TMPDIR; process.env.TMPDIR = parent;
  const f = await sourceBackfillFixture();
  let requests = 0;
  const out: string[] = [];
  const io: CliIo = { env: { HOME: parent, KIZUKI_AUTO_CONFIRM: "1" }, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: line => { out.push(line); }, err: () => {}, prompt: async () => "" };
  const planPath = join(parent, "plan.json"), bytes = JSON.stringify(f.plan); writeFileSync(planPath, bytes, { mode: 0o600 });
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.unavailable-fixture"\n[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="https://models.example.test/v1"\nmodel="fixture-throughput-model"\n', { mode: 0o600 });
  const fakeFetch: typeof globalThis.fetch = Object.assign(async (_url: unknown, options: any) => {
    requests++;
    const request = JSON.parse(String(options.body)), prompt = request.messages.map((m: any) => m.content).join("\n");
    const match = /<<<KZ-QUOTE ([0-9a-f]{32}) event:([0-9A-HJKMNP-TV-Z]{26})>>>\n([\s\S]*?)\n<<<KZ-END \1>>>/.exec(prompt)!;
    const id = match[2]!, text = match[3]!;
    expect(text).toBe(f.event.text.slice(0, 256));
    return Response.json({ model: "fixture-throughput-model", choices: [{ finish_reason: "stop", message: { role: "assistant",
      content: JSON.stringify(modelQuoteWire(response(id, text, true), [{ event_id: id, text }])) } }], usage: { prompt_tokens: 200, completion_tokens: 100 } });
  }, { preconnect: globalThis.fetch.preconnect });
  const observed = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  try {
    expect(await serveCommand.run(io, ["backfill-source", "--plan", planPath, "--plan-sha256", sha256Hex(bytes), "--json"])).toBe(0);
    const data = JSON.parse(out.join("\n")).data;
    expect(data).toMatchObject({ admission: { outcome: "settled", supports_added: 1, carried_forward: 2 }, canon: { status: "ok", model: { calls: 0 } }, projection_complete: true });
    expect(requests).toBe(1);
    expect(inspectCanonRecovery(f.db)).toMatchObject({ pending: false, projection_pending: 0 });
    expect(f.db.query("SELECT done_utf16 FROM extract_oversized_records").get()).toEqual({ done_utf16: 512 });
  } finally {
    observed.mockRestore(); f.db.close(); f.dispose();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});
