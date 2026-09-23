import { afterEach, beforeEach, expect, test, setDefaultTimeout } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureVaultId, hardenLedgerFile, setSourceGrant } from "@kizuki/core";
import { bindSourceEvent } from "../../core/src/ledger/source-grants";
import { sealLedger } from "@kizuki/core/internal";
import { REFLEX_LIMITS } from "@kizuki/core/reflex";
import { serveFixture } from "../../core/test/serving/helpers";
import type { Fixture } from "../../core/test/serving/helpers";
import { reflexCommand, readReflexRequestFile } from "../src/commands/reflex";
import type { CliIo } from "../src/commands/index";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

let f: Fixture;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeEach(async () => { f = await serveFixture(); ensureVaultId(f.vaultPath); hardenLedgerFile(join(f.vaultPath, ".kizuki", "kizuki.db")); sealLedger(f.vaultPath, f.db); });
afterEach(() => { server?.stop(true); server = undefined; f.dispose(); });
function io(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { env: { KIZUKI_VAULT: f.vaultPath, XDG_CONFIG_HOME: join(f.vaultPath, "config"), HOME: f.vaultPath }, vaultOverride: null,
    stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: line => out.push(line), err: line => err.push(line), prompt: async () => { throw new Error("unexpected prompt"); } } };
}
function requestFile(): string {
  const path = join(f.vaultPath, "reflex-request.json");
  writeFileSync(path, JSON.stringify({ assumptions: [{ id: "kettle", statement: "The kettle is on.", importance: "critical" }], event_ids: [f.events.public!], max_age_ms: REFLEX_LIMITS.max_age_ms }), { mode: 0o600 });
  return path;
}
test("public command without opt-in is an explicit unavailable JSON report, with diagnostics on stderr", async () => {
  const output = io();
  const code = await reflexCommand.run(output.io, ["--request", requestFile()]);
  expect(code).toBe(1); expect(output.out).toHaveLength(1);
  expect(JSON.parse(output.out[0]!).reason).toBe("not_configured"); expect(output.err.join(" ")).toContain("disabled");
  expect(output.err.join(" ")).not.toContain("The kettle is on");
});
test("explicit opt-in uses the real Jev adapter, exact source destination, and typed report", async () => {
  let calls = 0;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls++; expect(new URL(req.url).pathname).toBe("/v1/systemone");
    const body = await req.json() as { questions: Record<string, unknown>; model: string; state: unknown };
    expect(body.model).toBe("fixture-model"); expect(JSON.stringify(body.state)).toContain("the public kettle is on");
    return Response.json({ model: body.model, usage: { input_tokens: 12, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, {
      type: "choice", choice: "supports", confidence: 0.94, probabilities: { supports: 0.97, contradicts: 0.01, irrelevant: 0.01, unclear: 0.01 },
    }])) });
  } });
  const base = `http://127.0.0.1:${server.port}/v1`;
  writeFileSync(join(f.vaultPath, ".kizuki", "serve.toml"), `[ports.systemone]\nid = "kizuki.systemone.jev"\nbase_url = "${base}"\nmodel = "fixture-model"\n`);
  setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 0, operation_id: "reflex-cli-fixture", policy: {
    purposes: ["capture", "recall", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", sensitivity_floor: "public",
    egress: { model_endpoint: `${base}/systemone`, model: "fixture-model", external_retention: "provider_managed" },
  } });
  bindSourceEvent(f.db, f.events.public!, { source_key: f.sourceKey, expected_revision: 1 });
  sealLedger(f.vaultPath, f.db);
  const output = io();
  const code = await reflexCommand.run(output.io, ["--request", requestFile(), "--allow-model"]);
  expect(code).toBe(0); expect(calls).toBe(1); expect(output.err).toHaveLength(0);
  const report = JSON.parse(output.out[0]!);
  expect(report.status).toBe("assessed"); expect(report.authority).toBe("advisory_only"); expect(report.findings[0].verdict).toBe("supported");
  expect(report.matrix[0].event_id).toBe(f.events.public!);
});
test("HTML is an explicit output format and needs no browser or remote assets", async () => {
  const output = io(); await reflexCommand.run(output.io, ["--request", requestFile(), "--format", "html"]);
  expect(output.out[0]).toStartWith("<!doctype html>"); expect(output.out[0]).not.toContain("<script");
});
test("request file rejects symlinks, oversized input, invalid UTF-8, and unknown fields", () => {
  const file = requestFile(), link = join(f.vaultPath, "link.json"); symlinkSync(file, link);
  expect(() => readReflexRequestFile(link)).toThrow("invalid Reflex request file");
  writeFileSync(file, "x".repeat(16_385)); expect(() => readReflexRequestFile(file)).toThrow("invalid Reflex request file");
  writeFileSync(file, Buffer.from([0xff])); expect(() => readReflexRequestFile(file)).toThrow("invalid Reflex request file");
  writeFileSync(file, '{"execute":true}'); expect(() => readReflexRequestFile(file)).toThrow("invalid Reflex request file");
});
test("bad invocations fail before opening a vault or model port", async () => {
  const output = io();
  await expect(reflexCommand.run(output.io, [])).rejects.toThrow("reflex --request");
  await expect(reflexCommand.run(output.io, ["--request", requestFile(), "--format", "shell"])).rejects.toThrow("reflex --request");
  expect(output.out).toHaveLength(0); expect(output.err).toHaveLength(0);
});
test("the CLI process exposes reflex and preserves stdout, stderr, and unavailable exit status", async () => {
  const child = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), "reflex", "--request", requestFile()],
    env: { ...process.env, ...io().io.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1); expect(JSON.parse(out).schema).toBe("kizuki.reflex/v1"); expect(err).toContain("disabled");
});
