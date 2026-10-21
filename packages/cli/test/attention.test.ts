import { afterEach, expect, test } from "bun:test";
import { attentionFixture, ATTENTION_WHEN } from "../../core/test/helpers/attention-fixture";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);

test("CLI attention and App read the same cues; owner commands alter only dispositions", async () => {
  const f = await attentionFixture(), env = h.isolatedEnv({ KIZUKI_VAULT: f.vault.path });
  const io: CliIo = { env, vaultOverride: f.vault.path, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" };
  const app = createAppHost(io);
  const call = async (route: string, input: unknown) => {
    const response = await app.handle(new Request(`http://127.0.0.1/app/v1/${route}`, { method: "POST", body: JSON.stringify(input) }));
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const initialized = h.runCli(env, "init", f.vault.path, "--no-service");
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const expected = f.read(), cue = f.candidates()[0]!.cue;
    for (const args of [["attention"], ["world", "--operation", "attention"]]) {
      const cli = h.runCli(env, ...args, "--json");
      expect(cli.exitCode, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout).data.data.result.data).toEqual(expected);
    }
    const plain = h.runCli(env, "attention"); expect(plain.stdout).toContain(cue);
    expect((await call("world_view", { operation: "attention", ...ATTENTION_WHEN })).body.data.result.data).toEqual(expected);
    const before = f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all();
    const dismissed = h.runCli(env, "attention", "dismiss", cue, "--json");
    expect(dismissed.exitCode, dismissed.stderr).toBe(0);
    expect(JSON.parse(dismissed.stdout).data.disposition).toBe("dismissed");
    const until = new Date(Date.now() + 3600_000).toISOString();
    expect((await call("attention_disposition", { cue, action: "snooze", until })).body).toMatchObject({ ok: true, data: { disposition: "snoozed", snoozedUntil: until } });
    expect(f.db.query("SELECT claim_id,confidence,status FROM claims ORDER BY claim_id").all()).toEqual(before);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM canon_receipts").get()!.n).toBe(0);
    expect((await call("attention_disposition", { cue, action: "dismiss", execute: true })).status).toBe(400);
    expect(h.runCli(env, "attention", "snooze", cue).exitCode).toBe(2);
    const doctor = h.runCli(env, "doctor");
    // This fixture deliberately has no configured extraction provider; doctor
    // may report overall degraded health, but its read-only attention probe works.
    expect(doctor.stderr).toBe("");
    expect(doctor.stdout).toContain("attention: pending=0");
  } finally { await app.close(); f.dispose(); }
}, 120_000);
