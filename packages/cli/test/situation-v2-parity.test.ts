import { expect, test } from "bun:test";
import { serveWorldView } from "@kizuki/core/world";
import { situationV2Fixture, vocabulary } from "../../core/test/helpers/situation-v2-fixture";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { twoClients } from "../../mcp/test/helpers/two-clients";
import { envelopeOf } from "../../mcp/test/client";
import { createAppHost } from "../src/app/host";
import { createHelpers } from "./helpers";

function meaning(value: any) {
  expect(["current", "incomplete"]).toContain(value.result.status);
  const { view, validUntil, ...result } = value.result;
  if (view !== undefined) expect(view.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { ...value, result };
}

test("Situation v2 preserves commitment meaning through Core, MCP, HTTP, CLI and App while default callers retain v1", async () => {
  const clients = await twoClients({ seed: { subject: "topic:initial", label: "Initial" }, agent: { subjects: null } });
  const f = await situationV2Fixture(clients.db), h = createHelpers();
  const ctx = { ...f.ctx, vaultPath: clients.vaultPath }, env = h.isolatedEnv();
  const host = createAppHost({ env, vaultOverride: clients.vaultPath, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" });
  let http: Awaited<ReturnType<typeof startLoopback>> | undefined;
  try {
    expect(h.runCli(env, "init", clients.vaultPath, "--no-service", "--no-default").exitCode).toBe(0);
    await f.declare("person:ada", "person", "Ada");
    await f.declare("person:ben", "person", "Ben");
    for (const [predicate, id] of [["commitment.debtor", "person:ada"], ["commitment.creditor", "person:ben"]] as const)
      await f.write(predicate, { kind: "subject", ref: f.ref(id) }, { subject: "commitment:notes" });
    await f.write("commitment.status", vocabulary("commitment/done"), { subject: "commitment:notes" });
    const input = f.situationInput(ctx, { valid: { kind: "at", at: "2026-10-21T00:00:00Z" } });
    const core = serveWorldView(ctx, input);
    expect(meaning(envelopeOf(await clients.owner.call("world_view", input)).data)).toEqual(meaning(core.data));
    const app = await (await host.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(input) }))).json() as any;
    expect(app.ok).toBe(true);
    expect(meaning(app.data)).toEqual(meaning(core.data));
    http = await startLoopback(clients.db, clients.vaultPath);
    const response = await http.post("world_view", input);
    expect(response.status).toBe(200);
    expect(meaning((response.body as any).value.data)).toEqual(meaning(core.data));
    const args = ["--vault", clients.vaultPath, "world", "--operation", "situation", "--ref", f.findSituation().token, "--valid-at", "2026-10-21T00:00:00Z"];
    const json = h.runCli(env, ...args, "--card", "kizuki.situation-card/v2", "--json");
    expect(json.exitCode, json.stderr).toBe(0);
    expect(meaning(JSON.parse(json.stdout).data.data)).toEqual(meaning(core.data));
    const text = h.runCli(env, ...args, "--card", "kizuki.situation-card/v2");
    expect(text.exitCode, text.stderr).toBe(0);
    for (const value of ["Prepare notes", "Review draft", "claimed_done", "2026-10-23", "2026-10-22", "decided"]) expect(text.stdout).toContain(value);
    const legacy = h.runCli(env, ...args, "--json");
    expect(legacy.exitCode).toBe(0);
    expect(JSON.parse(legacy.stdout).data.data.result.data.schema).toBe("kizuki.situation-card/v1");
    expect(h.runCli(env, ...args, "--card", "kizuki.situation-card/v3").exitCode).toBe(2);
    expect((await clients.owner.call("world_view", { ...input, card: "kizuki.situation-card/v3" })).isError).toBe(true);
  } finally {
    await http?.stop(); await host.close(); f.dispose(); await clients.close(); h.cleanup();
  }
}, 120_000);
