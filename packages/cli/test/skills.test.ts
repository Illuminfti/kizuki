import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { skillFixture, PROCEDURE, WHEN } from "../../core/test/helpers/skill-fixture";
import { serveWorldView, type WorldReadResult } from "@kizuki/core/world";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);
function payload(body: WorldReadResult) { if (!("result" in body) || !("data" in body.result)) throw new Error("missing payload"); return body.result.data; }
test("real CLI processes and App route preserve procedures, skills, frameworks and outcome semantics", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db")), f = await skillFixture(db);
  const ctx = { ...f.ctx, vaultPath: setup.vault };
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" };
  const app = createAppHost(io);
  try {
    await f.file(0, "outcome.self_report");
    for (const [operation, input, args] of [
      ["procedure", { procedure: f.procedureRef }, ["--ref", f.procedureRef.token]],
      ["skill", { skill: f.skillRef }, ["--ref", f.skillRef.token]],
      ["framework", { framework: f.frameworkRef }, ["--ref", f.frameworkRef.token]],
      ["find_procedures", { about: f.find() }, ["--about", f.find().token]],
      ["outcome", { subject: PROCEDURE }, ["--subject", PROCEDURE]],
    ] as const) {
      const request = { operation, ...input, ...WHEN }, expected = payload(serveWorldView(ctx, request).data);
      const cli = h.runCli(setup.env, "world", "--operation", operation, ...args, "--json");
      expect(cli.exitCode, cli.stderr).toBe(0); expect(cli.stderr).toBe("");
      expect(payload(JSON.parse(cli.stdout).data.data)).toEqual(expected);
      const response = await app.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(request) }));
      const result = await response.json() as { ok: boolean; data: WorldReadResult };
      expect(result.ok).toBe(true); expect(payload(result.data)).toEqual(expected);
    }
    const plain = h.runCli(setup.env, "world", "--operation", "procedure", "--ref", f.procedureRef.token);
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(plain.stdout).toContain("Quoted step"); expect(plain.stdout).toContain("Counterexample"); expect(plain.stdout).toContain("execution authority: none");
    for (const args of [["--operation", "execute", "--ref", f.procedureRef.token], ["--operation", "procedure", "--ref", "bad"]])
      expect(h.runCli(setup.env, "world", ...args).exitCode).toBe(2);
  } finally { await app.close(); f.dispose(); db.close(); }
}, 120_000);
