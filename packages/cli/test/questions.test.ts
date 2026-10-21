import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { questionFixture, QUESTION_WHEN as WHEN } from "../../core/test/helpers/question-fixture";
import { serveWorldView, type WorldReadResult } from "@kizuki/core/world";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);
function payload(body: WorldReadResult) {
  if (!("result" in body) || !("data" in body.result)) throw new Error("world payload missing");
  return body.result.data;
}

test("real CLI processes and the App route return the same Question, evidence and scoped frontier", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const f = await questionFixture(db);
  const ctx = { ...f.ctx, vaultPath: setup.vault };
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false,
    stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" };
  const app = createAppHost(io);
  try {
    for (const [input, args] of [
      [{ operation: "question", question: f.questionRef, ...WHEN }, ["--operation", "question", "--ref", f.questionRef.token]],
      [{ operation: "find_questions", about: f.find(), ...WHEN }, ["--operation", "find_questions", "--about", f.find().token]],
      [{ operation: "frontier", about: f.find(), ...WHEN }, ["--operation", "frontier", "--about", f.find().token]],
    ] as const) {
      const expected = payload(serveWorldView(ctx, input).data);
      const cli = h.runCli(setup.env, "world", ...args, "--json");
      expect(cli.exitCode, cli.stderr).toBe(0); expect(cli.stderr).toBe("");
      expect(payload((JSON.parse(cli.stdout) as { data: { data: WorldReadResult } }).data.data)).toEqual(expected);
      const response = await app.handle(new Request("http://127.0.0.1/app/v1/world_view", {
        method: "POST", body: JSON.stringify(input),
      }));
      const body = await response.json() as { ok: boolean; data: WorldReadResult };
      expect(body.ok).toBe(true); expect(payload(body.data)).toEqual(expected);
    }
    const plain = h.runCli(setup.env, "world", "--operation", "question", "--ref", f.questionRef.token);
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(plain.stdout).toContain("When should I update a belief?");
    expect(plain.stdout).toContain("Status: open; understanding: unknown.");
    expect(plain.stdout).toContain(f.readQuestion().texts[0]!.assessments[0]!.evidence[0]!.admission.token);
    expect(plain.stderr).toBe("");
    const shared = h.runCli(setup.env, "world", "--operation", "share", "--of-operation", "question", "--ref", f.questionRef.token, "--json");
    expect(shared.exitCode, shared.stderr).toBe(0);
    const handle = JSON.parse(shared.stdout).data.data.result.data.handle as string;
    const resumed = h.runCli(setup.env, "world", "--resume", handle);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Status: open; understanding: unknown.");
  } finally { await app.close(); f.dispose(); db.close(); }
}, 120_000);
