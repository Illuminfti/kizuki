import test from "node:test";
import assert from "node:assert/strict";
import { preflight, simulateChange, traceImpact, ReflexError } from "../src/index";
import { fixture } from "./fixtures";
import type { Dependency, MemoryNode, Snapshot } from "../src/types";

test("counterfactual simulation is explicit and uses zero model calls", () => {
  const { snapshot, change } = fixture();
  const r = simulateChange(snapshot, change);
  assert.equal(r.mode, "counterfactual");
  assert.equal(r.metrics.requests_started, 0);
  assert.equal(r.impacts.length, 5);
  assert.equal(r.authorizes_execution, false);
  assert.equal(preflight(r, snapshot.binding, [{ id: "publish", assumptions: [{ node_id: "action:website", revision: "r4" }] }]).mode, "counterfactual");
});

test("a dependency trace carries source, claim and edge provenance", () => {
  const { snapshot, change } = fixture();
  const t = traceImpact(snapshot, change, "fact:local", "action:website");
  assert.deepEqual(t.nodes, ["fact:local", "decision:privacy", "action:website"]);
  assert.deepEqual(t.evidence_ids, ["claim:privacy", "claim:website", "edge:privacy", "edge:website", "event:config-change", "event:old"]);
  assert.equal(t.truncated, false);
});

test("display truncation never removes provenance", () => {
  const { snapshot, change } = fixture();
  const full = traceImpact(snapshot, change, "fact:local", "action:website");
  const short = traceImpact(snapshot, change, "fact:local", "action:website", 1);
  assert.equal(short.truncated, true);
  assert.deepEqual(short.nodes, ["fact:local"]);
  assert.deepEqual(short.evidence_ids, full.evidence_ids);
});

test("disconnected actions remain disconnected", () => {
  const { snapshot, change } = fixture();
  assert.deepEqual(traceImpact(snapshot, change, "fact:local", "action:lint"), { nodes: [], evidence_ids: [], truncated: false });
});

test("cycles terminate and do not duplicate impacts", () => {
  const { snapshot, change } = fixture();
  const cyclic = { ...snapshot, dependencies: [...snapshot.dependencies,
    { prerequisite: "action:website", dependent: "fact:local", evidence_ids: ["edge:cycle"] }] };
  const r = simulateChange(cyclic, change);
  assert.equal(r.impacts.length, 5);
  assert.ok(r.impacts.every((impact) => impact.reasons.length === 1));
});

test("shared dependencies retain every triggering root", () => {
  const { snapshot, change } = fixture();
  const extra = { ...snapshot, dependencies: [...snapshot.dependencies,
    { prerequisite: "decision:consent", dependent: "action:website", evidence_ids: ["edge:shared"] }] };
  const r = simulateChange(extra, { ...change, target_ids: ["fact:local", "decision:consent"] });
  assert.equal(r.impacts.find((i) => i.node_id === "action:website")?.reasons.length, 2);
});

test("input edge order does not change impact ordering or shortest traces", () => {
  const { snapshot, change } = fixture();
  const reversed = { ...snapshot, nodes: [...snapshot.nodes].reverse(), dependencies: [...snapshot.dependencies].reverse() };
  assert.deepEqual(simulateChange(snapshot, change).impacts, simulateChange(reversed, change).impacts);
  assert.deepEqual(traceImpact(snapshot, change, "fact:local", "action:enable"), traceImpact(reversed, change, "fact:local", "action:enable"));
});

test("trace helper refuses roots not nominated for the change", () => {
  const { snapshot, change } = fixture();
  assert.throws(() => traceImpact(snapshot, change, "decision:privacy", "action:website"), ReflexError);
});

test("preflight rejects duplicate steps and duplicate assumptions", () => {
  const { snapshot, change } = fixture();
  const r = simulateChange(snapshot, change);
  assert.throws(() => preflight(r, snapshot.binding, [{ id: "x", assumptions: [] }, { id: "x", assumptions: [] }]), ReflexError);
  assert.throws(() => preflight(r, snapshot.binding, [{ id: "x", assumptions: [{ node_id: "fact:local", revision: "r1" }, { node_id: "fact:local", revision: "r1" }] }]), ReflexError);
});

test("100 seeded random graphs agree with an independent transitive-closure oracle", () => {
  let seed = 271828;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 100; trial += 1) {
    const { snapshot: base, change } = fixture();
    const n = 16;
    const nodes: MemoryNode[] = Array.from({ length: n }, (_, i) => ({ id: `n:${i}`, kind: "fact", revision: "r1", statement: `Synthetic fact ${i}`, evidence_ids: [`e:${i}`], consequence: 1 }));
    const dependencies: Dependency[] = [];
    const closure = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j));
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
      if (i !== j && random() < 0.08) { dependencies.push({ prerequisite: `n:${i}`, dependent: `n:${j}`, evidence_ids: [`edge:${i}:${j}`] }); closure[i]![j] = true; }
    }
    for (let k = 0; k < n; k += 1) for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) closure[i]![j] = closure[i]![j]! || (closure[i]![k]! && closure[k]![j]!);
    const snapshot: Snapshot = { ...base, nodes, dependencies };
    const r = simulateChange(snapshot, { ...change, target_ids: ["n:0"] });
    const expected = nodes.filter((_, index) => closure[0]![index]).map((node) => node.id).sort();
    assert.deepEqual(r.impacts.map((impact) => impact.node_id).sort(), expected, `seeded trial ${trial}`);
  }
});

test("maximum-size graph runs without recursive stack growth", () => {
  const { snapshot: base, change } = fixture();
  const nodes: MemoryNode[] = Array.from({ length: 2000 }, (_, i) => ({ id: `n:${i}`, kind: "fact", revision: "r1", statement: `Node ${i}`, evidence_ids: [`e:${i}`], consequence: 1 }));
  const dependencies: Dependency[] = nodes.slice(1).map((_, i) => ({ prerequisite: `n:${i}`, dependent: `n:${i + 1}`, evidence_ids: [`edge:${i}`] }));
  const r = simulateChange({ ...base, nodes, dependencies }, { ...change, target_ids: ["n:0"] });
  assert.equal(r.impacts.length, 2000);
});
