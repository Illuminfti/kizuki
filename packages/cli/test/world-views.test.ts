import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { worldSeed } from "../../core/test/helpers/world-seed";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import type { WorldReadResult } from "@kizuki/core/world";
import { createHelpers } from "./helpers";

setDefaultTimeout(120_000);
const h = createHelpers();
afterEach(h.cleanup);
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
function result(value: WorldReadResult) {
  if (!("result" in value)) throw new Error("no world result");
  return value.result;
}

test("CLI processes retain a baseline and share/resume in JSON and text with clean diagnostics", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const seeded = await worldSeed(db); db.close();
  const read = (args: string[]) => {
    const reply = h.runCli(setup.env, "world", ...args);
    expect(reply.exitCode, reply.stderr).toBe(0); expect(reply.stderr).toBe("");
    return result((JSON.parse(reply.stdout) as { data: { data: WorldReadResult } }).data.data);
  };
  const args = ["--operation", "concept", "--ref", seeded.ref!.token];
  const first = read([...args, "--json"]);
  if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
  expect(read([...args, "--prior-view", first.view.token, "--json"])).toEqual({ status: "unchanged", view: first.view, validUntil: first.validUntil });
  const text = h.runCli(setup.env, "world", ...args, "--prior-view", first.view.token);
  expect(text.exitCode).toBe(0); expect(text.stdout).toContain("Unchanged since the prior view"); expect(text.stderr).toBe("");
  const shared = read([...args, "--share", "--json"]);
  if (!("data" in shared) || shared.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
  expect(read(["--resume", shared.data.handle, "--json"])).toMatchObject({ status: "current", data: { schema: "kizuki.concept-card/v1" } });
  const resumed = h.runCli(setup.env, "world", "--resume", shared.data.handle);
  expect(resumed.exitCode).toBe(0); expect(resumed.stdout).toContain("Revise beliefs using evidence"); expect(resumed.stderr).toBe("");
  const invalid = h.runCli(setup.env, "world", ...args, "--prior-view", "invalid");
  expect(invalid.exitCode).toBe(2); expect(invalid.stdout).toBe("");
});

test("HTTP and App read the same baseline states and portable handles", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const seeded = await worldSeed(db);
  const loopback = await startLoopback(db, setup.vault);
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => {}, err: () => {}, prompt: async () => "" };
  const app = createAppHost(io);
  const http = async (input: Record<string, unknown>) => {
    const reply = await loopback.post("world_view", input);
    expect(reply.status).toBe(200);
    return result((reply.body as { value: { data: WorldReadResult } }).value.data);
  };
  const callApp = async (input: object) => {
    const reply = await app.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(input) }));
    const body = await reply.json() as { ok: boolean; data: WorldReadResult };
    expect(body.ok).toBe(true); return result(body.data);
  };
  try {
    const input = { operation: "concept", concept: seeded.ref, ...WHEN };
    const first = await http(input);
    if (first.status !== "current" || !("validUntil" in first)) throw new Error("no baseline");
    const conditional = { ...input, priorView: first.view };
    const same = { status: "unchanged" as const, view: first.view, validUntil: first.validUntil };
    expect(await http(conditional)).toEqual(same); expect(await callApp(conditional)).toEqual(same);
    const shared = await callApp({ operation: "share", of: { operation: "concept", concept: seeded.ref }, ...WHEN });
    if (!("data" in shared) || shared.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
    const inputResume = { operation: "resume", handle: shared.data.handle, ...WHEN };
    const b = await http(inputResume), a = await callApp(inputResume);
    expect(b).toMatchObject({ status: "current" }); expect(a).toMatchObject({ status: "current" });
    if (!("data" in b) || !("data" in a)) throw new Error("no payload");
    expect(b.data).toEqual(a.data);
    const unknown = { ...input, priorView: { kind: "view", token: "A".repeat(43) } };
    expect(await http(unknown)).toEqual({ status: "new_view_required" }); expect(await callApp(unknown)).toEqual({ status: "new_view_required" });
  } finally { await app.close(); await loopback.stop(); db.close(); }
});
