import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "../../src/serving/world-view";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import type { ServeContext } from "../../src/serving/types";
import type { WorldSlice } from "../../src/contracts/world-slice";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { tempVault } from "../helpers/vault";
import { worldSeed, type WorldSeed } from "../helpers/world-seed";
import { EMPTY_SUMMARY_MODEL, completeEmptyWorldSummaries } from "../helpers/world-consolidation";
import { HIDDEN_MUTATIONS, checkNoninterference, hiddenScene, type ReadCase } from "../helpers/noninterference";

const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const request = (task: string) => ({ operation: "slice", task, kinds: ["concept"], budgetTokens: 2000, ...WHEN });

beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => setSystemTime());

async function scene(count = 6, consolidate = true) {
  const vault = tempVault("kizuki-task-relevance-"), db = openLedger(`${vault.path}/.kizuki/kizuki.db`);
  const seeds: WorldSeed[] = [], subjects: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const subject = `topic:task-${i}`;
      subjects.push(subject);
      seeds.push(await worldSeed(db, { subject, label: `Subject${i}`, model: EMPTY_SUMMARY_MODEL,
        predicates: [{ predicate: "concept.definition", object: { kind: "literal", value: `Supported definition ${i}` } }], discover: false }));
    }
    if (consolidate) await completeEmptyWorldSummaries(db, vault.path);
    const agent = addAgent(db, "task-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects, rate_limit_per_minute: 1000 });
    const ctx: ServeContext = { db, vaultPath: vault.path, principal: authenticate(db, agent.token)! };
    const discovered = serveWorldView(ctx, { operation: "find_concepts", label: "", ...WHEN }).data;
    if (!("result" in discovered) || !("data" in discovered.result) || !("matches" in discovered.result.data)) throw Error("fixture discovery missing");
    const ordered = [...discovered.result.data.matches].sort((a, b) => a.ref.token.localeCompare(b.ref.token));
    return { db, ctx, seeds, ordered, dispose() { db.close(); vault.dispose(); } };
  } catch (error) { db.close(); vault.dispose(); throw error; }
}

function slice(ctx: ServeContext, task: string): WorldSlice {
  const response = serveWorldView(ctx, request(task)).data;
  if (!("result" in response) || !("data" in response.result) || response.result.data.schema !== "kizuki.world-slice/v1") throw Error("slice body missing");
  expect(packetTokens(JSON.stringify(response))).toBeLessThanOrEqual(2000);
  return response.result.data;
}

test("task relevance selects the fifth authorized card before the four-card cap", async () => {
  const f = await scene();
  try {
    const target = f.ordered[4]!;
    expect(f.ordered.slice(0, 4).map(item => item.ref.token)).not.toContain(target.ref.token);
    const result = slice(f.ctx, `Explore ${target.labels[0]!.toUpperCase()}`);
    const selected = [...result.constraints, ...result.detail];
    expect(selected.length).toBeGreaterThan(0);
    expect(new Set(selected.map(item => item.node.token))).toEqual(new Set([target.ref.token]));
    expect(result.complete).toBe(true);
    expect(result.coverage.gaps).not.toContain("traversal_limit");
    const other = f.ordered[0]!;
    const changed = slice(f.ctx, `Explore ${other.labels[0]}`);
    expect(new Set([...changed.constraints, ...changed.detail].map(item => item.node.token))).toEqual(new Set([other.ref.token]));
  } finally { f.dispose(); }
}, 120_000);

test("empty and unmatched task hints retain the bounded reference-order fallback", async () => {
  const f = await scene();
  try {
    const empty = slice(f.ctx, ""), unmatched = slice(f.ctx, "Unrelated material");
    expect({ ...unmatched, task: "", tokens: 0 }).toEqual({ ...empty, tokens: 0 });
    expect(empty.coverage.gaps).toContain("traversal_limit");
    expect([...empty.constraints, ...empty.detail].every(item => f.ordered.slice(0, 4).some(match => match.ref.token === item.node.token))).toBe(true);
  } finally { f.dispose(); }
}, 120_000);

test("unselected authorized label support remains a dependency of the retained selection", async () => {
  const f = await scene();
  try {
    const target = f.ordered[4]!, input = request(target.labels[0]!);
    const response = serveWorldView(f.ctx, input).data;
    if (!("result" in response) || response.result.status !== "current" || !("kind" in response.result.view)) throw Error("complete retained task slice required");
    const retained = { ...input, priorView: response.result.view };
    expect(serveWorldView(f.ctx, retained).data).toMatchObject({ result: { status: "unchanged" } });
    const ignored = f.seeds.find(seed => seed.label !== target.labels[0])!;
    revokeSourceGrant(f.db, { source_key: ignored.sourceKey, expected_revision: 1, operation_id: "selection-support-revoked" });
    expect(serveWorldView(f.ctx, retained).data).toMatchObject({ result: { status: "new_view_required" } });
    expect(new Set([...slice(f.ctx, target.labels[0]!).detail].map(item => item.node.token))).toEqual(new Set([target.ref.token]));
  } finally { f.dispose(); }
}, 120_000);

test("an unfinished discovery page cannot produce a complete task slice", async () => {
  // Consolidation is unrelated to discovery's page limit; keep all 33 real
  // candidates without expanding the shared helper's bounded pass budget.
  const f = await scene(33, false);
  try {
    const observed = collectReadFrames(() => serveWorldView(f.ctx, request(f.ordered[4]!.labels[0]!)));
    expect(observed.result.data).toMatchObject({ result: { status: "incomplete", reasons: expect.arrayContaining(["traversal_limit"]) } });
    expect(observed.result.data).not.toHaveProperty("result.view");
    expect(observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0)).toBeLessThan(200);
    expect(observed.frames.reduce((n, frame) => n + frame.budget.bytes, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { f.dispose(); }
}, 120_000);

test("label text redacted from the consumer cannot select a candidate", async () => {
  const f = await scene();
  try {
    const target = f.ordered[4]!, task = target.labels[0]!;
    const visible = slice(f.ctx, task);
    expect(new Set([...visible.constraints, ...visible.detail].map(item => item.node.token))).toEqual(new Set([target.ref.token]));
    const redacted = slice({ ...f.ctx, servingSecrets: [task] }, task);
    expect([...redacted.constraints, ...redacted.detail].map(item => item.node.token)).not.toContain(target.ref.token);
    expect(redacted.coverage.gaps).toContain("traversal_limit");
  } finally { f.dispose(); }
}, 120_000);

for (const mutation of HIDDEN_MUTATIONS) {
  test(`task selection preserves bytes, work and a retained baseline under ${mutation.name}`, async () => {
    expect(await checkNoninterference({ mutations: [mutation], scene: async () => {
      const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
      await completeEmptyWorldSummaries(f.db, f.vaultPath);
      return f;
    }, cases: f => {
      const input = request("Bayesian updating"), initial = serveWorldView(f.reader, input).data;
      if (!("result" in initial) || initial.result.status !== "current" || !("kind" in initial.result.view)) throw Error("privacy baseline missing");
      const inputs = [input, { ...input, priorView: initial.result.view }];
      return inputs.map((query, index): ReadCase => {
        let stats = { rowsExamined: 0, claimsVerified: 0, parsedBytes: 0 };
        return { name: index === 0 ? "task slice" : "retained task slice", run(ctx) {
          const observed = collectReadFrames(() => serveWorldView(ctx, query));
          if (index === 1) expect(observed.result.data).toMatchObject({ result: { status: "unchanged" } });
          stats = { rowsExamined: observed.frames.reduce((n, frame) => n + frame.stats.rowsExamined, 0),
            claimsVerified: observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0),
            parsedBytes: observed.frames.reduce((n, frame) => n + frame.budget.bytes, 0) };
          return observed.result;
        }, stats: () => stats };
      });
    } })).toEqual([]);
  }, 120_000);
}
