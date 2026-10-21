import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { fingerprintOf, wireDigest } from "../../src/world/views/store";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView, type WorldData, type WorldReadResult } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { cardFixture } from "./card-fixture";

const LEARNED = "2030-01-09T00:00:00.000Z";
function current(result: WorldReadResult) {
  if (!("result" in result) || result.result.status !== "current" || !("kind" in result.result.view)) throw new Error("current view missing");
  return { ...result.result, view: result.result.view };
}
function snapshot(body: WorldData) {
  if (body.schema !== "kizuki.concept-card/v1" || body.knownAt.kind !== "snapshot") throw new Error("snapshot missing");
  return body.knownAt;
}
async function fixture() {
  const db = openLedger(":memory:"), f = await cardFixture(db);
  db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(LEARNED);
  const agent = addAgent(db, "historical-conditional-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
  const ctx = { ...f.ctx, principal: authenticate(db, agent.token)! };
  const input = { operation: "concept", concept: f.find(ctx), valid: { kind: "all" }, knownAt: { kind: "time", at: LEARNED } };
  return { ...f, ctx, input, close() { f.dispose(); db.close(); } };
}

for (const operation of ["concept", "history"] as const) test(`${operation} timestamp conditional reads reuse exact bytes across hidden writes without consuming cache slots`, async () => {
  const f = await fixture();
  f.input.operation = operation;
  try {
    const first = current(serveWorldView(f.ctx, f.input).data);
    const beforeTokens = f.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all();
    const read = () => collectReadFrames(() => serveWorldView(f.ctx, { ...f.input, priorView: first.view }));
    const before = read();
    expect(before.result.data).toMatchObject({ result: { status: "unchanged", view: first.view } });
    await f.write("concept.example", { kind: "literal", value: "A private unrelated example" }, { subject: "topic:hidden", floor: "private" });
    for (let i = 0; i < 20; i++) {
      const after = read();
      expect(after.result.data).toEqual(before.result.data);
      expect(after.result.quoted).toEqual(before.result.quoted);
      expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    }
    expect(f.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all()).toEqual(beforeTokens);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "conditional-revoke" });
    expect(read().result.data).toMatchObject({ result: { status: "new_view_required" } });
  } finally { f.close(); }
}, 120_000);

test("a visible historical change issues a new snapshot whose cutoff agrees with the returned body", async () => {
  const f = await fixture();
  try {
    const first = current(serveWorldView(f.ctx, f.input).data), oldSnapshot = snapshot(first.data);
    await f.write("concept.example", { kind: "literal", value: "A newly recorded visible example" });
    const next = current(serveWorldView(f.ctx, { ...f.input, priorView: first.view }).data), nextSnapshot = snapshot(next.data);
    expect(nextSnapshot).not.toEqual(oldSnapshot);
    const oldBody = current(serveWorldView(f.ctx, { ...f.input, knownAt: oldSnapshot }).data).data;
    const newBody = current(serveWorldView(f.ctx, { ...f.input, knownAt: nextSnapshot }).data).data;
    if (oldBody.schema !== "kizuki.concept-card/v1" || newBody.schema !== "kizuki.concept-card/v1") throw new Error("card missing");
    expect(oldBody.relations).toHaveLength(0);
    expect(newBody.relations).toHaveLength(1);
  } finally { f.close(); }
}, 120_000);

for (const cause of ["evicted", "expired"] as const) test(`an ${cause} snapshot cannot be reused by a retained timestamp view`, async () => {
  const f = await fixture();
  try {
    const first = current(serveWorldView(f.ctx, f.input).data), oldSnapshot = snapshot(first.data);
    f.db.query(cause === "evicted" ? "DELETE FROM world_view_tokens WHERE fingerprint=?"
      : "UPDATE world_view_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE fingerprint=?").run(fingerprintOf(Buffer.from("known-snapshot")));
    const next = current(serveWorldView(f.ctx, { ...f.input, priorView: first.view }).data);
    expect(snapshot(next.data)).not.toEqual(oldSnapshot);
    expect(serveWorldView(f.ctx, { ...f.input, knownAt: oldSnapshot }).data).toMatchObject({ result: { status: "new_view_required" } });
    expect(serveWorldView(f.ctx, { ...f.input, knownAt: snapshot(next.data) }).data).toMatchObject({ result: { status: "current" } });
  } finally { f.close(); }
}, 120_000);

function afterSnapshot(db: Database, mutate: () => void): Database {
  let fired = false;
  return new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "transaction") return (run: () => unknown) => {
      const tx = target.transaction(run), finish = (result: unknown) => {
        if (!fired && !target.inTransaction && result !== null && typeof result === "object" && "withheld" in result) { fired = true; mutate(); }
        return result;
      };
      return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

for (const supplied of [false, true]) test(`final publication rechecks ${supplied ? "supplied" : "reused"} snapshot eviction`, async () => {
  const f = await fixture();
  try {
    const first = current(serveWorldView(f.ctx, f.input).data), oldSnapshot = snapshot(first.data);
    const db = afterSnapshot(f.db, () => {
      f.db.query("DELETE FROM world_view_tokens WHERE fingerprint=?").run(fingerprintOf(Buffer.from("known-snapshot")));
    });
    const result = serveWorldView({ ...f.ctx, db }, supplied ? { ...f.input, knownAt: oldSnapshot } : { ...f.input, priorView: first.view }).data;
    if (supplied) expect(result).toMatchObject({ result: { status: "new_view_required" } });
    else {
      const replacement = snapshot(current(result).data);
      expect(replacement).not.toEqual(oldSnapshot);
      expect(serveWorldView(f.ctx, { ...f.input, knownAt: replacement }).data).toMatchObject({ result: { status: "current" } });
    }
  } finally { f.close(); }
}, 120_000);

test("final publication cannot return unchanged after its paired view was evicted", async () => {
  const f = await fixture();
  try {
    const first = current(serveWorldView(f.ctx, f.input).data);
    const db = afterSnapshot(f.db, () => f.db.query("DELETE FROM world_view_tokens WHERE token_hash=?").run(wireDigest(first.view.token)));
    expect(serveWorldView({ ...f.ctx, db }, { ...f.input, priorView: first.view }).data).toMatchObject({ result: { status: "new_view_required" } });
  } finally { f.close(); }
}, 120_000);
