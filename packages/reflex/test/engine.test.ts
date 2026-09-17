import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChange, preflight, bindReflexHost } from "../src/index";
import { fixture, many, response, scripted, sleep } from "./fixtures";

test("supported change fans out through two decisions into two actions", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted() });
  assert.equal(r.status, "complete");
  assert.equal(r.authorizes_execution, false);
  assert.equal(r.mode, "observed");
  assert.equal(r.impacts.length, 5);
  assert.ok(!r.impacts.some((i) => i.node_id === "action:lint"));
  assert.deepEqual(r.impacts.find((i) => i.node_id === "action:website")?.reasons,
    [{ target_id: "fact:local", effect: "needs_revalidation", via: "decision:privacy", distance: 2 }]);
  assert.equal(r.metrics.questions_started, 5);
  assert.equal(r.metrics.input_tokens, 100);
});

test("default mode never sends anything and returns uncertainty", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change);
  assert.equal(r.status, "incomplete");
  assert.equal(r.judgments[0]?.reason, "not_configured");
  assert.equal(r.metrics.requests_started, 0);
  assert.equal(r.impacts.length, 5);
});

test("corroborating evidence does not invalidate dependencies or authorize execution", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted(response("supports")) });
  assert.equal(r.impacts.length, 0);
  assert.equal(r.status, "complete");
  assert.equal(r.authorizes_execution, false);
});

test("unknown and contradictory judgments remain distinct", async () => {
  const { snapshot, change } = many(2);
  const r = await analyzeChange(snapshot, change, { host: { async isCurrent() { return true; },
    async evaluateAuthorized(_, scope) { return response(scope.target_id === "fact:0" ? "contradicts" : "unknown"); } } });
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.judgments.map((j) => j.effect), ["needs_revalidation", "unknown"]);
});

test("request and byte budgets are reserved atomically", async () => {
  const { snapshot, change } = many(20);
  const r = await analyzeChange(snapshot, change, { host: scripted(), limits: { concurrency: 8, max_requests: 3 } });
  assert.equal(r.metrics.requests_started, 3);
  assert.equal(r.judgments.filter((j) => j.reason === "budget_exhausted").length, 17);
  assert.equal(r.status, "incomplete");
});

test("zero request budget is an explicit no-I/O path", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted(), limits: { max_requests: 0 } });
  assert.equal(r.metrics.requests_started, 0);
  assert.equal(r.judgments[0]?.reason, "budget_exhausted");
});

test("UTF-8 request bytes are limited before host evaluation", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, { ...change, statement: "🧠".repeat(3000) }, { host: scripted(), limits: { max_request_bytes: 10_000 } });
  assert.equal(r.metrics.requests_started, 0);
  assert.equal(r.status, "incomplete");
});

test("total byte budget is never exceeded", async () => {
  const { snapshot, change } = many(20);
  const r = await analyzeChange(snapshot, change, { host: scripted(), limits: { max_total_request_bytes: 7_000 } });
  assert.ok(r.metrics.request_bytes <= 7_000);
  assert.ok(r.metrics.requests_started > 0 && r.metrics.requests_started < 20);
});

test("concurrent workers respect the configured ceiling", async () => {
  let active = 0;
  let maximum = 0;
  const { snapshot, change } = many(12);
  const r = await analyzeChange(snapshot, change, { limits: { concurrency: 3 }, host: {
    async isCurrent() { return true; }, async evaluateAuthorized() {
      active += 1; maximum = Math.max(maximum, active); await sleep(3); active -= 1; return response();
    } } });
  assert.equal(maximum, 3);
  assert.equal(r.metrics.max_in_flight, 3);
  assert.equal(r.metrics.requests_started, 12);
});

test("response completion order cannot reorder candidate results", async () => {
  const { snapshot, change } = many(4);
  const r = await analyzeChange(snapshot, change, { host: { async isCurrent() { return true; },
    async evaluateAuthorized(_, scope) { await sleep((4 - Number(scope.target_id.split(":")[1])) * 3); return response(); } } });
  assert.deepEqual(r.judgments.map((j) => j.target_id), change.target_ids);
});

test("hung adapters cannot create an ever-growing queue of abandoned requests", async () => {
  const { snapshot, change } = many(40);
  let calls = 0;
  const r = await analyzeChange(snapshot, change, { limits: { concurrency: 3, request_timeout_ms: 15, total_timeout_ms: 100 },
    host: { async isCurrent() { return true; }, async evaluateAuthorized() { calls += 1; return await new Promise(() => {}); } } });
  assert.equal(calls, 3);
  assert.equal(r.status, "incomplete");
  assert.ok(r.judgments.every((j) => j.effect === "unknown"));
});

test("total deadline also bounds a hanging freshness callback", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { limits: { request_timeout_ms: 10, total_timeout_ms: 15 },
    host: { async isCurrent() { return await new Promise(() => {}); }, async evaluateAuthorized() { assert.fail("must not call"); } } });
  assert.equal(r.metrics.requests_started, 0);
  assert.equal(r.status, "incomplete");
});

test("expired snapshots are rejected before any host call", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange({ ...snapshot, binding: { ...snapshot.binding, expires_at: "2020-01-01T00:00:00Z" } }, change,
    { host: { async isCurrent() { assert.fail("must not call"); }, async evaluateAuthorized() { assert.fail("must not call"); } } });
  assert.equal(r.status, "stale");
  assert.equal(r.metrics.requests_started, 0);
});

test("revocation during model evaluation invalidates the entire report", async () => {
  const { snapshot, change } = fixture();
  let current = true;
  const r = await analyzeChange(snapshot, change, { host: { async isCurrent() { return current; },
    async evaluateAuthorized() { current = false; return response(); } } });
  assert.equal(r.status, "stale");
  assert.ok(r.judgments.every((j) => j.reason === "stale_snapshot"));
});

test("late rejected promises are consumed and cannot mutate a completed result", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { limits: { request_timeout_ms: 5 },
    host: { async isCurrent() { return true; }, async evaluateAuthorized() { await sleep(25); throw new Error("private token"); } } });
  const before = JSON.stringify(r);
  await sleep(30);
  assert.equal(JSON.stringify(r), before);
  assert.ok(!before.includes("private token"));
});

test("provider error messages never enter reports", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: { async isCurrent() { return true; }, async evaluateAuthorized() { throw new Error("SECRET-vault-path-key"); } } });
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(r.judgments[0]?.reason, "host_unavailable");
});

test("caller mutation after invocation cannot alter the frozen snapshot", async () => {
  const { snapshot, change } = fixture();
  const mutable = structuredClone(snapshot);
  const work = analyzeChange(mutable, change, { host: scripted() });
  (mutable.nodes[0] as { statement: string }).statement = "mutated";
  (mutable.binding as { snapshot_id: string }).snapshot_id = "wrong";
  const r = await work;
  assert.equal(r.binding.snapshot_id, snapshot.binding.snapshot_id);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.impacts));
});

test("minimal model state contains only the nominated pair, not the vault", async () => {
  const { snapshot, change } = fixture();
  await analyzeChange(snapshot, change, { host: { async isCurrent() { return true; }, async evaluateAuthorized(request, scope) {
    const json = JSON.stringify(request.state);
    assert.ok(json.includes(change.statement));
    assert.ok(!json.includes("Publish the on-device-only"));
    assert.ok(!json.includes("agent:test"));
    assert.deepEqual(scope.evidence_ids, ["event:config-change", "event:old"]);
    assert.ok(Object.isFrozen(request));
    return response();
  } } });
});

test("explicit adapter never reaches the configured port when egress is denied", async () => {
  const { snapshot, change } = fixture();
  let sent = 0;
  const host = bindReflexHost({ model_ref: "test-jev", async evaluate() { sent += 1; return response(); } },
    { async isCurrent() { return true; }, async allowModelEgress() { return false; } });
  const r = await analyzeChange(snapshot, change, { host });
  assert.equal(sent, 0);
  assert.equal(r.status, "incomplete");
});

test("explicit adapter rechecks freshness after egress authorization", async () => {
  const { snapshot, change } = fixture();
  let current = true;
  let sent = 0;
  const host = bindReflexHost({ model_ref: "test-jev", async evaluate() { sent += 1; return response(); } },
    { async isCurrent() { return current; }, async allowModelEgress() { current = false; return true; } });
  const r = await analyzeChange(snapshot, change, { host });
  assert.equal(sent, 0);
  assert.equal(r.status, "stale");
});

test("explicit adapter calls the existing port with the full evidence grant scope", async () => {
  const { snapshot, change } = fixture();
  let sent = 0;
  const host = bindReflexHost({ model_ref: "test-jev", async evaluate(request) { sent += 1; assert.equal(Object.keys(request.questions).length, 5); return response(); } },
    { async isCurrent() { return true; }, async allowModelEgress(scope, model) {
      assert.equal(model, "test-jev"); assert.equal(scope.binding.policy_epoch, 7);
      assert.deepEqual(scope.evidence_ids, ["event:config-change", "event:old"]); return true;
    } });
  assert.equal((await analyzeChange(snapshot, change, { host })).status, "complete");
  assert.equal(sent, 1);
});

test("preflight detects changed, unknown, undeclared and stale-revision assumptions", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted() });
  const p = preflight(r, snapshot.binding, [
    { id: "publish", assumptions: [{ node_id: "action:website", revision: "r4" }] },
    { id: "lint", assumptions: [{ node_id: "action:lint", revision: "r6" }] },
    { id: "unknown", assumptions: [{ node_id: "not-in-snapshot", revision: "r1" }] },
    { id: "stale", assumptions: [{ node_id: "action:lint", revision: "r0" }] },
    { id: "empty", assumptions: [] },
  ]);
  assert.deepEqual(p.steps.map((s) => s.status), ["revalidate", "no_change_detected", "unexamined", "unexamined", "unexamined"]);
  assert.equal(p.authorizes_execution, false);
});

test("preflight cannot reuse a report across principals or policy epochs", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted(response("supports")) });
  for (const binding of [{ ...snapshot.binding, principal_id: "other" }, { ...snapshot.binding, policy_epoch: 8 }]) {
    assert.equal(preflight(r, binding, [{ id: "lint", assumptions: [{ node_id: "action:lint", revision: "r6" }] }]).steps[0]?.status, "unexamined");
  }
});

test("failed evaluations never masquerade as known zero token usage", async () => {
  const { snapshot, change } = fixture();
  const r = await analyzeChange(snapshot, change, { host: scripted({}) });
  assert.equal(r.metrics.usage_complete, false);
  assert.equal(r.metrics.requests_started, 1);
  assert.equal((await analyzeChange(snapshot, change)).metrics.usage_complete, true);
});

test("a model destination change after authorization does not send the request", async () => {
  const { snapshot, change } = fixture();
  const port = { model_ref: "destination:approved", async evaluate() { assert.fail("must not send"); } };
  const host = bindReflexHost(port, { async isCurrent() { return true; }, async allowModelEgress() { port.model_ref = "destination:other"; return true; } });
  const r = await analyzeChange(snapshot, change, { host });
  assert.equal(r.status, "stale");
});
