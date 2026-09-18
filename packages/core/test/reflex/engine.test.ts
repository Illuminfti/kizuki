import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { SystemOnePort, SystemOneRequest, SystemOneResponse } from "../../src/contracts/systemone";
import { evaluateMatrix, reduceFindings } from "../../src/reflex/engine";
import { parseReflexRequest } from "../../src/reflex/input";
import type { ReflexAssumption, ReflexEvidence } from "../../src/reflex/types";

const assumptions: ReflexAssumption[] = [{ id: "launch", statement: "The launch is approved.", importance: "critical" }];
const evidence = (n = 2): ReflexEvidence[] => Array.from({ length: n }, (_, i) => ({
  event_id: `event-${i}`, occurred_at: "2026-09-17T10:00:00Z", sensitivity: "public", sha256: "a".repeat(64), eligibility: "eligible",
}));
function answer(request: SystemOneRequest, label = "supports"): SystemOneResponse {
  return { model: "fixture-model", usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, {
    type: "choice", choice: label, confidence: 0.94,
    probabilities: Object.fromEntries(["supports", "contradicts", "irrelevant", "unclear"].map(x => [x, x === label ? 0.97 : 0.01])),
  }])) };
}
function port(run: (request: SystemOneRequest) => Promise<SystemOneResponse>): SystemOnePort {
  return { descriptor: { id: "kizuki.systemone.fixture", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null }, model_ref: "fixture-model", evaluate: run,
    health: async () => ({ status: "ready", detail: {} }), close: async () => {} };
}
const input = (n = 2) => ({ assumptions, evidence: evidence(n).map(e => ({ ...e, text: "Synthetic launch evidence." })) });

test("rejects oversized, ambiguous and accessor-shaped requests without reading getters", () => {
  assert.throws(() => parseReflexRequest({ assumptions: [], event_ids: [] }));
  assert.throws(() => parseReflexRequest({ assumptions, event_ids: [], execute: true }));
  assert.throws(() => parseReflexRequest({ assumptions: [...assumptions, ...assumptions], event_ids: [] }));
  assert.throws(() => parseReflexRequest({ assumptions, event_ids: ["x", "x"] }));
  assert.throws(() => parseReflexRequest({ assumptions, event_ids: [], max_age_ms: NaN }));
  assert.throws(() => parseReflexRequest({ assumptions: [{ ...assumptions[0], statement: "界".repeat(512) }], event_ids: [] }));
  assert.throws(() => parseReflexRequest({ assumptions: [{ ...assumptions[0], statement: "approve\u001b[2J" }], event_ids: [] }));
  let called = false;
  assert.throws(() => parseReflexRequest({ get assumptions() { called = true; return assumptions; }, event_ids: [] }));
  assert.equal(called, false);
  const original = { assumptions: [{ ...assumptions[0]! }], event_ids: ["event-1"] };
  const parsed = parseReflexRequest(original);
  original.assumptions[0]!.statement = "Changed";
  assert.equal(parsed.assumptions[0]!.statement, "The launch is approved.");
});

test("batches the cross product and binds every typed answer to code-owned source IDs", async () => {
  const requests: SystemOneRequest[] = [];
  const result = await evaluateMatrix(input(), port(async req => { requests.push(req); return answer(req); }), Date.now() + 1000, () => true);
  assert.equal(result.status, "assessed");
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.deadline_ms > 0 && requests[0]!.deadline_ms <= 1000);
  assert.equal(Object.keys(requests[0]!.questions).length, 2);
  assert.equal(result.cells.length, 2);
  assert.deepEqual(result.cells.map(c => c.event_id), ["event-0", "event-1"]);
  assert.equal(result.metrics.input_tokens, 10);
  assert.ok(Object.values(requests[0]!.questions).every(q => q.type === "choice" && !Array.isArray(q.criteria)));
  assert.ok(Object.values(requests[0]!.questions).every(q => q.instructions.includes("untrusted data")));
});

test("one contradiction survives any number of supporting votes", () => {
  const cells = evidence(12).map((e, i) => ({ assumption_id: "launch", event_id: e.event_id, relation: i === 11 ? "contradicts" as const : "supports" as const, confidence: 0.95, probability: 0.97 }));
  const findings = reduceFindings(assumptions, cells);
  assert.equal(findings[0]!.verdict, "conflicted");
  assert.equal(findings[0]!.supporting.length, 11);
  assert.deepEqual(findings[0]!.contradicting, ["event-11"]);
});

test("ambiguous evidence prevents an apparently all-clear finding", () => {
  const cells = evidence().map((e, i) => ({ assumption_id: "launch", event_id: e.event_id, relation: i === 0 ? "supports" as const : "unclear" as const, confidence: 0.95, probability: 0.97 }));
  assert.equal(reduceFindings(assumptions, cells)[0]!.verdict, "unknown");
  assert.equal(reduceFindings(assumptions, [cells[0]!])[0]!.verdict, "supported");
  assert.equal(reduceFindings(assumptions, [])[0]!.verdict, "unknown");
});

test("low-confidence classifications become unclear, not affirmative evidence", async () => {
  const result = await evaluateMatrix(input(1), port(async req => {
    const valid = answer(req); return { ...valid, answers: Object.fromEntries(Object.entries(valid.answers).map(([k, v]) => [k, { ...v, confidence: 0.2 }])) } as SystemOneResponse;
  }), Date.now() + 1000, () => true);
  assert.equal(result.cells[0]!.relation, "unclear");
});

for (const [name, mutate] of Object.entries<Record<string, (r: SystemOneResponse) => unknown>[string]>({
  missing: r => ({ ...r, answers: {} }),
  extra: r => ({ ...r, answers: { ...r.answers, alien: Object.values(r.answers)[0] } }),
  not_finite: r => ({ ...r, usage: { input_tokens: Infinity, output_tokens: 0 } }),
  bad_type: r => ({ ...r, answers: Object.fromEntries(Object.keys(r.answers).map(k => [k, { type: "noul", noul: 1 }])) }),
  bad_distribution: r => ({ ...r, answers: Object.fromEntries(Object.keys(r.answers).map(k => [k, { type: "choice", choice: "supports", confidence: 1, probabilities: { supports: 1, contradicts: 1, irrelevant: 1, unclear: 1 } }])) }),
  forged_winner: r => ({ ...r, answers: Object.fromEntries(Object.keys(r.answers).map(k => [k, { type: "choice", choice: "supports", confidence: 1, probabilities: { supports: 0.01, contradicts: 0.97, irrelevant: 0.01, unclear: 0.01 } }])) }),
})) {
  test(`rejects malformed model response: ${name}`, async () => {
    const result = await evaluateMatrix(input(1), port(async req => mutate(answer(req)) as SystemOneResponse), Date.now() + 1000, () => true);
    assert.equal(result.status, "unavailable"); assert.equal(result.reason, "invalid_response"); assert.deepEqual(result.cells, []);
  });
}

test("bounded parallelism is real and failed batches never produce partial reassurance", async () => {
  let active = 0, peak = 0, calls = 0;
  const releases: (() => void)[] = [];
  const run = evaluateMatrix(input(16), port(async req => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
    if (calls === 2) throw new Error("private provider text must not escape");
    return answer(req);
  }), Date.now() + 1000, () => true);
  await Promise.resolve();
  assert.equal(peak, 2);
  for (const release of releases) release();
  const result = await run;
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.cells, []);
  assert.equal(calls, 2); assert.ok(!JSON.stringify(result).includes("private provider text"));
});

test("revocation checks stop dispatching the next queued batch", async () => {
  let calls = 0;
  const result = await evaluateMatrix(input(16), port(async req => { calls++; return answer(req); }), Date.now() + 1000, () => calls === 0);
  assert.equal(calls, 1); assert.equal(result.reason, "invalidated"); assert.deepEqual(result.cells, []);
});

test("deadline bounds a hung port, which stays quarantined until its work settles", async () => {
  let release!: () => void;
  const stuck = port(async req => { await new Promise<void>(r => { release = r; }); return answer(req); });
  const expired = await evaluateMatrix(input(1), stuck, Date.now() + 15, () => true);
  assert.equal(expired.reason, "timeout");
  const busy = await evaluateMatrix(input(1), stuck, Date.now() + 1000, () => true);
  assert.equal(busy.reason, "busy");
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  const recovered = await evaluateMatrix(input(0), stuck, Date.now() + 1000, () => true);
  assert.equal(recovered.status, "assessed");
});

test("expired deadline and denied dispatch send nothing", async () => {
  let calls = 0;
  const p = port(async req => { calls++; return answer(req); });
  assert.equal((await evaluateMatrix(input(1), p, Date.now() - 1, () => true)).reason, "timeout");
  assert.equal((await evaluateMatrix(input(1), p, Date.now() + 1000, () => false)).reason, "invalidated");
  assert.equal(calls, 0);
});

test("maximum cross product stays inside serialized state and question budgets", async () => {
  const requests: SystemOneRequest[] = [];
  const full = { assumptions: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, statement: "a".repeat(512), importance: "normal" as const })),
    evidence: evidence(16).map(e => ({ ...e, text: "x".repeat(4096) })) };
  const result = await evaluateMatrix(full, port(async req => { requests.push(req); return answer(req); }), Date.now() + 1000, () => true);
  assert.equal(result.cells.length, 128); assert.equal(requests.length, 4);
  assert.ok(requests.every(req => Buffer.byteLength(JSON.stringify(req.state), "utf8") <= 24576 && Object.keys(req.questions).length <= 32));
});
test("JSON escaping cannot inflate a single evidence state past the outbound cap", async () => {
  let calls = 0;
  const expanded = { ...input(1), evidence: evidence(1).map(e => ({ ...e, text: "\u0000".repeat(4096) })) };
  const result = await evaluateMatrix(expanded, port(async req => { calls++; return answer(req); }), Date.now() + 1000, () => true);
  assert.equal(result.reason, "request_too_large"); assert.equal(calls, 0);
});
