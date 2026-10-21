import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { personFixture, ADA, PERSON_WHEN as WHEN } from "../../core/test/helpers/person-fixture";
import { serveWorldView, type WorldReadResult } from "@kizuki/core/world";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);
function payload(body: WorldReadResult) {
  if (!("result" in body) || !("data" in body.result)) throw new Error("world payload missing");
  return body.result.data;
}
test("CLI processes and App return the same Person, attribution and portable view", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const f = await personFixture(db), ctx = { ...f.ctx, vaultPath: setup.vault };
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false,
    stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" };
  const app = createAppHost(io);
  try {
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA, holder: ADA, mode: "quoted" });
    for (const [input, args] of [
      [{ operation: "person", person: f.personRef, ...WHEN }, ["--operation", "person", "--ref", f.personRef.token]],
      [{ operation: "find_people", label: "Ada", ...WHEN }, ["--operation", "find_people", "--label", "Ada"]],
    ] as const) {
      const expected = payload(serveWorldView(ctx, input).data);
      const cli = h.runCli(setup.env, "world", ...args, "--json");
      expect(cli.exitCode, cli.stderr).toBe(0); expect(cli.stderr).toBe("");
      expect(payload(JSON.parse(cli.stdout).data.data)).toEqual(expected);
      const response = await app.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(input) }));
      const body = await response.json() as { ok: boolean; data: WorldReadResult };
      expect(body.ok).toBe(true); expect(payload(body.data)).toEqual(expected);
    }
    const plain = h.runCli(setup.env, "world", "--operation", "person", "--ref", f.personRef.token);
    expect(plain.exitCode, plain.stderr).toBe(0); expect(plain.stdout).toContain("Reviewer");
    expect(plain.stdout).toContain("mode=quoted"); expect(plain.stdout).toContain("no agreement inferred");
    const shared = h.runCli(setup.env, "world", "--operation", "share", "--of-operation", "person", "--ref", f.personRef.token, "--json");
    expect(shared.exitCode, shared.stderr).toBe(0);
    const handle = JSON.parse(shared.stdout).data.data.result.data.handle as string;
    const resumed = h.runCli(setup.env, "world", "--resume", handle);
    expect(resumed.exitCode, resumed.stderr).toBe(0); expect(resumed.stdout).toContain("Reviewer");
  } finally { await app.close(); f.dispose(); db.close(); }
}, 120_000);
