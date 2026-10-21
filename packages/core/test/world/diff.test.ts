import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { OWNER, setGrant } from "../../src/agents";
import { readWorldView } from "../../src/serving/world-view";
import { hiddenScene, type NoninterferenceScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";
import { serveWorldView } from "../../src/serving/world-view";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { purgeEvents } from "../../src/ledger/purge";
import { wireDigest, clearViewTokens } from "../../src/world/views/store";
import { correctionKit } from "../helpers/world-correct-kit";
import { serveCorrect } from "../../src/serving/correct";
import { compareWorldViews } from "../../src/world/views/diff";
import { withWorldOps } from "../../src/world/ops/registry";
import { parseWorldRef } from "../../src/world/ops/parse";
import { randomBytes } from "node:crypto";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

setDefaultTimeout(120_000);
const scenes: NoninterferenceScene[] = [];
afterEach(() => { for (const scene of scenes.splice(0)) scene.dispose(); });
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
function result(read: ReturnType<typeof readWorldView>) {
  if (!("result" in read)) throw Error("world result missing");
  return read.result;
}

test("diff compares an existing object view and makes its replacement reusable", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const ctx = { db: scene.db, vaultPath: scene.vaultPath, principal: OWNER };
  const of = { operation: "concept", concept: scene.visible.concept.ref! };
  const before = result(readWorldView(ctx, { ...of, ...WHEN }));
  if (before.status !== "current" || !("kind" in before.view) || !("validUntil" in before)) throw Error("complete baseline required");
  expect(result(readWorldView(ctx, { operation: "diff", of, priorView: before.view, ...WHEN })))
    .toEqual({ status: "unchanged", view: before.view, validUntil: before.validUntil });
  await worldSeed(scene.db, { sourceKey: scene.visible.concept.sourceKey, subject: "topic:bayes",
    label: "Bayesian updating", discover: false, predicates: [
      { predicate: "concept.definition", object: { kind: "literal", value: "An additional independently recorded definition" } },
    ] });
  const changed = result(readWorldView(ctx, { operation: "diff", of, priorView: before.view, ...WHEN }));
  expect(changed).toMatchObject({ status: "current", data: { schema: "kizuki.world-diff/v1", truncated: false } });
  if (changed.status !== "current" || !("kind" in changed.view) || changed.data.schema !== "kizuki.world-diff/v1")
    throw Error("complete changed diff required");
  expect((changed.data as unknown as { added: unknown[] }).added.length).toBeGreaterThan(0);
  expect(result(readWorldView(ctx, { operation: "diff", of, priorView: changed.view, ...WHEN })))
    .toMatchObject({ status: "unchanged", view: changed.view });
  expect(result(readWorldView(ctx, { ...of, ...WHEN, priorView: changed.view })))
    .toMatchObject({ status: "unchanged", view: changed.view });
});

test("owner correction appears as removed and added claim refs, then the replacement baseline is unchanged", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const kit = correctionKit(scene.db, scene.vaultPath);
  await kit.declare("concept", "topic:diff", "Correction diff concept");
  await kit.write({ subject: "topic:diff", predicate: "concept.definition", object: { literal: "Old definition" } });
  kit.materialize("topic:diff");
  const of = { operation: "concept", concept: kit.find(kit.ctx, "concept", "Correction diff") };
  const before = result(serveWorldView(kit.ctx, { ...of, ...WHEN }).data);
  if (before.status !== "current" || !("kind" in before.view) || before.data.schema !== "kizuki.concept-card/v1") throw Error("complete baseline required");
  const old = before.data.definitions[0]!.claim;
  await serveCorrect(kit.ctx, { statement: "Use the new definition.", target: { world_claim: old }, mode: "replace_object", object: { kind: "literal", value: "New definition" } });
  const changed = result(serveWorldView(kit.ctx, { operation: "diff", of, priorView: before.view, ...WHEN }).data);
  expect(changed).toMatchObject({ status: "current", data: { schema: "kizuki.world-diff/v1", removed: [old], truncated: false } });
  if (changed.status !== "current" || !("kind" in changed.view) || changed.data.schema !== "kizuki.world-diff/v1") throw Error("diff required");
  expect(changed.data.added).toHaveLength(1);
  expect(changed.data.added[0]).not.toEqual(old);
  expect(result(serveWorldView(kit.ctx, { operation: "diff", of, priorView: changed.view, ...WHEN }).data)).toMatchObject({ status: "unchanged" });
});

for (const cause of ["unknown", "expired", "erased", "principal", "query", "revoked", "purged", "restart", "narrowed", "capacity"] as const) {
  test(`diff refuses a ${cause} baseline without old identifiers or reasons`, async () => {
    const scene = await hiddenScene(); scenes.push(scene);
    const ctx = scene.reader, of = { operation: "concept", concept: scene.refs.concept };
    const before = result(serveWorldView(ctx, { ...of, ...WHEN }).data);
    if (before.status !== "current" || !("kind" in before.view)) throw Error("baseline required");
    let priorView = before.view;
    if (cause === "unknown") priorView = { kind: "view", token: randomBytes(32).toString("base64url") };
    if (cause === "expired") scene.db.query("UPDATE world_view_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?").run(wireDigest(priorView.token));
    if (cause === "erased") scene.db.query("DELETE FROM world_view_tokens WHERE token_hash=?").run(wireDigest(priorView.token));
    if (cause === "restart") clearViewTokens(scene.db);
    if (cause === "narrowed") setGrant(scene.db, "narrow-reader", { subjects: [] });
    if (cause === "capacity") scene.db.query("DELETE FROM world_view_partitions WHERE principal_id=(SELECT agent_id FROM agents WHERE name='narrow-reader')").run();
    if (cause === "revoked") revokeSourceGrant(scene.db, { source_key: scene.visible.concept.sourceKey, expected_revision: 1, operation_id: "diff-revoke" });
    if (cause === "purged") {
      purgeEvents(scene.db, scene.vaultPath, { event_id: scene.visible.concept.eventId }, "diff-purge");
    }
    const response = serveWorldView(cause === "principal" ? { ...ctx, principal: OWNER } : ctx,
      { operation: "diff", of, priorView, ...WHEN, ...(cause === "query" ? { valid: { kind: "unknown_only" } } : {}) });
    expect(response.data).toEqual({ schema: "kizuki.world-view/v1", operation: "diff", result: { status: "new_view_required" } });
    expect(response.quoted).toEqual([]);
    expect(JSON.stringify(response)).not.toContain(priorView.token);
  });
}

test("diff accepts only one object request and requires its baseline", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const of = { operation: "concept", concept: scene.refs.concept };
  const before = result(readWorldView(scene.reader, { ...of, ...WHEN }));
  if (before.status !== "current" || !("kind" in before.view)) throw Error("baseline required");
  for (const request of [
    { of }, { of: { operation: "find_concepts", label: "Bayesian" }, priorView: before.view },
    { of: { ...of, valid: WHEN.valid }, priorView: before.view },
    { of: { operation: "diff", of }, priorView: before.view },
  ]) expect(() => readWorldView(scene.reader, { operation: "diff", ...request, ...WHEN })).toThrow("invalid world-view input");
});

test("restored vault requires a fresh baseline while preserving authorized current evidence", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const ctx = { ...scene.reader, principal: OWNER }, of = { operation: "concept", concept: scene.visible.concept.ref! };
  const before = result(serveWorldView(ctx, { ...of, ...WHEN }).data);
  if (before.status !== "current" || !("kind" in before.view)) throw Error("baseline required");
  const dir = mkdtempSync(join(tmpdir(), "kizuki-diff-restore-"));
  let db: Database | undefined;
  try {
    exportVault(scene.db, scene.vaultPath, join(dir, "backup"));
    const vaultPath = join(dir, "restored"); restoreVault(join(dir, "backup"), vaultPath);
    db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
    const restored = { db, vaultPath, principal: OWNER };
    expect(result(serveWorldView(restored, { operation: "diff", of, priorView: before.view, ...WHEN }).data)).toEqual({ status: "new_view_required" });
    expect(result(serveWorldView(restored, { ...of, ...WHEN }).data)).toMatchObject({ status: "current", data: { schema: "kizuki.concept-card/v1" } });
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("missing recorded history cannot become an unchanged diff", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const of = { operation: "concept", concept: scene.refs.concept };
  const before = result(serveWorldView(scene.reader, { ...of, ...WHEN }).data);
  if (before.status !== "current" || !("kind" in before.view)) throw Error("baseline required");
  expect(result(serveWorldView(scene.reader, { operation: "diff", of, priorView: before.view,
    valid: WHEN.valid, knownAt: { kind: "time", at: "1900-01-01T00:00:00.000Z" } }).data)).toEqual({ status: "new_view_required" });
});

test("publication rechecks a baseline erased after the fresh comparison", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const of = { operation: "concept", concept: scene.refs.concept };
  const before = result(serveWorldView(scene.reader, { ...of, ...WHEN }).data);
  if (before.status !== "current" || !("kind" in before.view)) throw Error("baseline required");
  const baseline = before.view;
  let erased = false;
  const db = new Proxy(scene.db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "transaction") return (run: () => unknown) => {
      const tx = target.transaction(run), finish = (value: unknown) => {
        if (!erased && !target.inTransaction && value !== null && typeof value === "object" && "withheld" in value) {
          erased = true; target.query("DELETE FROM world_view_tokens WHERE token_hash=?").run(wireDigest(baseline.token));
        }
        return value;
      };
      return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(result(serveWorldView({ ...scene.reader, db }, { operation: "diff", of, priorView: before.view, ...WHEN }).data)).toEqual({ status: "new_view_required" });
  expect(erased).toBe(true);
});

test("diff returns an incomplete fresh card and never stores it as a baseline", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const ctx = { ...scene.reader, principal: OWNER };
  let incomplete = false;
  await withWorldOps([{
    name: "diff_fixture", source: "claims", views: true,
    keys: { required: ["object"], optional: [] }, dataSchemas: ["kizuki.diff-fixture/v1"],
    parse: input => parseWorldRef(input.object, "object"),
    readObject: () => ({ status: "not_found" }),
    run: () => ({ status: "data", data: { schema: "kizuki.diff-fixture/v1", statements: [] }, gaps: incomplete ? ["coverage"] : null }),
  }], () => {
    const of = { operation: "diff_fixture", object: scene.visible.concept.ref! };
    const first = result(readWorldView(ctx, { ...of, ...WHEN }));
    if (first.status !== "current" || !("kind" in first.view)) throw Error("baseline required");
    const tokens = scene.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all();
    incomplete = true;
    expect<unknown>(result(readWorldView(ctx, { operation: "diff", of, priorView: first.view, ...WHEN }))).toEqual({ status: "incomplete", data: { schema: "kizuki.diff-fixture/v1", statements: [] }, reasons: ["coverage"] });
    expect(scene.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all()).toEqual(tokens);
  });
});

test("relation comparison bounds each class and records only changed qualifiers", () => {
  const ref = () => ({ kind: "claim", token: randomBytes(32).toString("base64url") });
  const stable = Array.from({ length: 129 }, () => ({ schema: "kizuki.relation/v1", claim: ref(),
    perspective: { mode: "asserted" }, valid: { kind: "unknown" }, context: [], assessments: [], conflict: "none_observed" }));
  const old = { stable, removed: Array.from({ length: 129 }, ref) };
  const fresh = { stable: stable.map(item => ({ ...item, conflict: "present" })), added: Array.from({ length: 129 }, ref) };
  const diff = compareWorldViews(old, fresh);
  expect(diff.added).toHaveLength(128); expect(diff.removed).toHaveLength(128); expect(diff.changed).toHaveLength(128);
  expect(diff.changed.every(change => change.fields.join(",") === "conflict")).toBe(true);
  expect(diff.truncated).toBe(true);
  expect(compareWorldViews(old, old)).toEqual({ schema: "kizuki.world-diff/v1", added: [], removed: [], changed: [], truncated: false });
});

test("a full view cache can replace a changed baseline without evicting its publication dependency", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const ctx = { ...scene.reader, principal: OWNER }, of = { operation: "concept", concept: scene.visible.concept.ref! };
  const first = result(serveWorldView(ctx, { ...of, ...WHEN }).data);
  if (first.status !== "current" || !("kind" in first.view)) throw Error("baseline required");
  scene.db.query("DELETE FROM world_view_tokens WHERE token_hash<>?").run(wireDigest(first.view.token));
  scene.db.query("UPDATE world_view_tokens SET created_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?").run(wireDigest(first.view.token));
  for (let i = 0; i < 15; i++) serveWorldView(ctx, { ...of, ...WHEN });
  await worldSeed(scene.db, { sourceKey: scene.visible.concept.sourceKey, subject: "topic:bayes", label: "Bayesian updating", discover: false,
    predicates: [{ predicate: "concept.example", object: { kind: "literal", value: "A fresh cache-capacity example" } }] });
  expect(result(serveWorldView(ctx, { operation: "diff", of, priorView: first.view, ...WHEN }).data)).toMatchObject({ status: "current", data: { schema: "kizuki.world-diff/v1", truncated: false } });
  expect(scene.db.query<{ n: number }, []>("SELECT count(*) AS n FROM world_view_tokens WHERE partition_id=0").get()!.n).toBe(16);
});

test("public diff truncation is incomplete and oversized fresh projections are unavailable", async () => {
  const scene = await hiddenScene(); scenes.push(scene);
  const ctx = { ...scene.reader, principal: OWNER };
  let statements: unknown[] = [], padding = "";
  await withWorldOps([{
    name: "diff_bounds", source: "claims", views: true,
    keys: { required: ["object"], optional: [] }, dataSchemas: ["kizuki.diff-bounds/v1"],
    parse: input => parseWorldRef(input.object, "object"), readObject: () => ({ status: "not_found" }),
    run: () => ({ status: "data", data: { schema: "kizuki.diff-bounds/v1", statements, padding }, gaps: null }),
  }], () => {
    const of = { operation: "diff_bounds", object: scene.visible.concept.ref! };
    const first = result(readWorldView(ctx, { ...of, ...WHEN }));
    if (first.status !== "current" || !("kind" in first.view)) throw Error("baseline required");
    const request = { operation: "diff", of, priorView: first.view, ...WHEN };
    statements = Array.from({ length: 129 }, () => ({ kind: "claim", token: randomBytes(32).toString("base64url") }));
    const partial = result(readWorldView(ctx, request));
    expect(partial).toMatchObject({ status: "incomplete", data: { schema: "kizuki.world-diff/v1", truncated: true }, reasons: ["traversal_limit"] });
    if (partial.status !== "incomplete" || partial.data.schema !== "kizuki.world-diff/v1") throw Error("partial diff required");
    expect(partial.data.added).toHaveLength(128); expect(partial).not.toHaveProperty("view");
    padding = "x".repeat(256 * 1024);
    expect(result(readWorldView(ctx, request))).toEqual({ status: "unavailable", reason: "budget" });
  });
});
