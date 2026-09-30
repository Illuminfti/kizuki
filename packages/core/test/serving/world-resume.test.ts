import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate, revokeAgent, setGrant } from "../../src/agents";
import { readWorldView, serveWorldView } from "@kizuki/core/world";
import { withWorldOps } from "@kizuki/core/testing";
import { exportVault, restoreVault } from "../../src/export";
import { rebuildWorldLayer } from "../../src/derived";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { runServeDaemon } from "../../src/serve/daemon";
import { hiddenScene } from "../helpers/noninterference";
import { pingOp, PING_INPUT } from "./world-test-op";
import type { ServeContext } from "../../src/serving/types";

setDefaultTimeout(120_000);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const REQUIRED = { status: "new_view_required" } as const;
async function setup() {
  const made = await hiddenScene(); cleanup.push(() => made.dispose());
  const owner: ServeContext = { db: made.db, vaultPath: made.vaultPath, principal: OWNER };
  const read = { operation: "concept", concept: made.visible.concept.ref!, ...WHEN };
  return { made, owner, read };
}
function result(ctx: ServeContext, input: unknown) {
  const value = readWorldView(ctx, input);
  if (!("result" in value)) throw new Error("no result");
  return value.result;
}
function share(ctx: ServeContext, ref: { kind: "object"; token: string }) {
  const value = result(ctx, { operation: "share", of: { operation: "concept", concept: ref }, ...WHEN });
  if (!("data" in value) || value.data.schema !== "kizuki.resume-handle/v1") throw new Error("no handle");
  return value.data;
}
const resume = (handle: string) => ({ operation: "resume", handle, ...WHEN });

test("resume expiry, unknown, unreadable, revoked issuer and erased target return identical results", async () => {
  const { made, owner } = await setup();
  const shared = share(made.reader, made.refs.concept);
  expect(Date.parse(shared.expiresAt) - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  const denied = addAgent(made.db, "empty-reader", { ...OWNER_AGENT_GRANT, subjects: [] });
  const deniedCtx = { ...owner, principal: authenticate(made.db, denied.token)! };
  expect(result(deniedCtx, resume(shared.handle))).toEqual(REQUIRED);
  expect(result(owner, resume("A".repeat(43)))).toEqual(REQUIRED);
  made.db.query("UPDATE world_resume_handles SET expires_at='2000-01-01T00:00:00.000Z'").run();
  expect(result(owner, resume(shared.handle))).toEqual(REQUIRED);
  const live = share(made.reader, made.refs.concept);
  revokeAgent(made.db, "narrow-reader");
  expect(result(owner, resume(live.handle))).toEqual(REQUIRED);
  expect(made.db.query("SELECT count(*) AS n FROM world_resume_handles").get()).toEqual({ n: 0 });
  const own = share(owner, made.visible.concept.ref!);
  purgeEvents(made.db, made.vaultPath, { event_id: made.visible.concept.eventId }, "synthetic-resume-purge");
  expect(result(owner, resume(own.handle))).toEqual(REQUIRED);
  expect(made.db.query("SELECT count(*) AS n FROM world_resume_handles").get()).toEqual({ n: 0 });
});

test("share capacity and handle eviction are issuer-local; handles contain no payload or raw handle", async () => {
  const { made, owner } = await setup();
  const first = share(owner, made.visible.concept.ref!);
  const peer = share(made.reader, made.refs.concept);
  for (let i = 0; i < 16; i++) share(owner, made.visible.concept.ref!);
  expect(result(owner, resume(first.handle))).toEqual(REQUIRED);
  expect(result(owner, resume(peer.handle))).toMatchObject({ status: "current" });
  expect(made.db.query("SELECT count(*) AS n FROM world_resume_handles WHERE partition_id=0").get()).toEqual({ n: 16 });
  const rows = made.db.query("SELECT * FROM world_resume_handles").all();
  expect(JSON.stringify(rows)).not.toContain(peer.handle);
  expect(JSON.stringify(rows)).not.toContain("Bayesian");
  if (made.reader.principal.kind !== "agent") throw new Error("no agent");
  made.db.query("DELETE FROM world_view_partitions WHERE principal_id=?").run(made.reader.principal.agent.agent_id);
  expect(result(made.reader, { operation: "share", of: { operation: "concept", concept: made.refs.concept }, ...WHEN })).toEqual({ status: "unavailable", reason: "storage" });
});

test("a full partition map preserves all reservations and the next agent still reads correctly", async () => {
  const { made, owner } = await setup();
  for (let i = 0; i < 62; i++) addAgent(made.db, `reader-${i}`, OWNER_AGENT_GRANT);
  const overflow = addAgent(made.db, "overflow-reader", OWNER_AGENT_GRANT);
  const ctx = { ...owner, principal: authenticate(made.db, overflow.token)! };
  const found = result(ctx, { operation: "find_concepts", label: "Bayesian updating", ...WHEN });
  if (!("data" in found) || !("matches" in found.data)) throw new Error("no discovery");
  expect(result(ctx, { operation: "concept", concept: found.data.matches[0]!.ref, ...WHEN })).toMatchObject({ status: "current", view: { status: "not_issued" } });
  expect(made.db.query("SELECT count(*) AS n FROM world_view_partitions").get()).toEqual({ n: 64 });
  revokeAgent(made.db, "reader-0");
  setGrant(made.db, "overflow-reader", {});
  expect(made.db.query("SELECT 1 FROM world_view_partitions WHERE principal_id=?").get(overflow.agent.agent_id)).not.toBeNull();
});

// Oracle binding: world-longitudinal-design#x_a_restore_old (a still-unexpired baseline after restore).
test("backup, restore and rebuild erase tokens and handles; a fresh authorized read survives", async () => {
  const { made, owner, read } = await setup();
  const prior = result(owner, read);
  if (prior.status !== "current" || !("validUntil" in prior)) throw new Error("no baseline");
  const shared = share(owner, made.visible.concept.ref!);
  const dir = mkdtempSync(join(tmpdir(), "kizuki-view-copy-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  exportVault(made.db, made.vaultPath, join(dir, "backup"));
  restoreVault(join(dir, "backup"), join(dir, "restored"));
  const copy = openLedger(join(dir, "restored", ".kizuki", "kizuki.db")); cleanup.push(() => copy.close());
  const ctx = { ...owner, db: copy, vaultPath: join(dir, "restored") };
  expect(copy.query("SELECT count(*) AS n FROM world_view_tokens").get()).toEqual({ n: 0 });
  expect(copy.query("SELECT count(*) AS n FROM world_resume_handles").get()).toEqual({ n: 0 });
  expect(result(ctx, { ...read, priorView: prior.view })).toEqual(REQUIRED);
  expect(result(ctx, resume(shared.handle))).toEqual(REQUIRED);
  expect(result(ctx, read)).toMatchObject({ status: "current", view: { kind: "view" } });
  rebuildWorldLayer(made.db);
  expect(result(owner, { ...read, priorView: prior.view })).toEqual(REQUIRED);
  expect(result(owner, resume(shared.handle))).toEqual(REQUIRED);
});

test("service restart invalidates earlier tokens without removing portable handles", async () => {
  const { made, owner, read } = await setup();
  const prior = result(owner, read);
  if (prior.status !== "current" || !("validUntil" in prior)) throw new Error("no baseline");
  const shared = share(owner, made.visible.concept.ref!);
  await runServeDaemon(made.db, made.vaultPath, { once: true, http: false, rails: [] });
  expect(result(owner, { ...read, priorView: prior.view })).toEqual(REQUIRED);
  expect(result(owner, resume(shared.handle))).toMatchObject({ status: "current" });
});

test("payload bounds, sixteen slots and fixed lifetimes apply at the public seam", async () => {
  const { made, owner } = await setup();
  const bounded = { ...pingOp, name: "bounded_view", views: true as const, run: () => ({ status: "data" as const, data: { schema: "kizuki.test-ping/v1", text: "x".repeat(256 * 1024 - 100) }, gaps: null }) };
  await withWorldOps([bounded], () => {
    const input = { ...PING_INPUT, operation: bounded.name };
    for (let i = 0; i < 17; i++) expect(result(owner, input)).toMatchObject({ status: "current", view: { kind: "view" } });
    const row = made.db.query<{ n: number; total: number; maximum: number }, []>("SELECT count(*) AS n,sum(bytes) AS total,max(bytes) AS maximum FROM world_view_tokens WHERE partition_id=0").get()!;
    expect(row.n).toBe(16); expect(row.total).toBeLessThanOrEqual(4 * 1024 * 1024); expect(row.maximum).toBeLessThanOrEqual(256 * 1024);
    for (const stored of made.db.query<{ created_at: string; expires_at: string }, []>("SELECT created_at,expires_at FROM world_view_tokens").all()) expect(Date.parse(stored.expires_at) - Date.parse(stored.created_at)).toBe(15 * 60 * 1000);
  });
  const huge = { ...bounded, run: () => ({ status: "data" as const, data: { schema: "kizuki.test-ping/v1", text: "x".repeat(256 * 1024) }, gaps: null }) };
  await withWorldOps([huge], () => expect(result(owner, { ...PING_INPUT, operation: huge.name })).toEqual({ status: "unavailable", reason: "budget" }));
});

test("invalid and ungranted resume calls are audited without recording the handle", async () => {
  const { made, owner } = await setup();
  const shared = share(owner, made.visible.concept.ref!);
  const denied = addAgent(made.db, "no-world-reader", { ...OWNER_AGENT_GRANT, tools: ["search"] });
  const ctx = { ...owner, principal: authenticate(made.db, denied.token)! };
  expect(() => serveWorldView(ctx, resume(shared.handle))).toThrow("tool not granted");
  expect(() => serveWorldView(owner, { ...resume(shared.handle), extra: true })).toThrow("invalid arguments");
  const rows = made.db.query("SELECT * FROM agent_audit WHERE tool='world_view'").all();
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(rows)).not.toContain(shared.handle);
});
