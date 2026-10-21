import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import { verificationScene } from "../helpers/world-verification";
import { cardFixture } from "./card-fixture";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { validateWorldSlice, type WorldSlice } from "../../src/contracts/world-slice";

const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
test("slice projects authorized evidence without quoted text and fits its whole world response", async () => {
  const scene = await verificationScene();
  try {
    const result = serveWorldView(scene.reader, { operation: "slice", task: "Resume the launch", kinds: ["situation"], budgetTokens: 2000, ...when });
    expect(result.quoted).toEqual([]);
    expect(result.canon).toEqual([]);
    expect(result.data).toHaveProperty("result.data.schema", "kizuki.world-slice/v1");
    expect(packetTokens(JSON.stringify(result.data))).toBeLessThanOrEqual(2000);
  } finally { scene.dispose(); }
});

test("slice preserves complete qualified constraints, drops optional prose, and revalidates retained views", async () => {
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    const input = { operation: "slice", task: "Apply Bayesian updating", kinds: ["concept"], budgetTokens: 2000, ...when };
    const pending = serveWorldView(f.ctx, input);
    expect(pending.data).toMatchObject({ result: { status: "incomplete", reasons: expect.arrayContaining(["pending_consolidation"]) } });
    await f.write("concept.counterexample", { kind: "literal", value: "A copied answer is not independent evidence." }, { mode: "reported" });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const agent = addAgent(f.db, "slice-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:bayes"], rate_limit_per_minute: 1000 });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    let chosen: any;
    for (let budgetTokens = 500; budgetTokens <= 2000; budgetTokens += 50) {
      const response = serveWorldView(ctx, { ...input, budgetTokens }).data;
      expect(packetTokens(JSON.stringify(response))).toBeLessThanOrEqual(budgetTokens);
      if (!("result" in response) || response.result.status !== "current" || !("kind" in response.result.view)) continue;
      const data = response.result.data as WorldSlice;
      if (data.constraints.length === 1 && data.detail.length === 0 && data.truncated) { chosen = { response, budgetTokens }; break; }
    }
    expect(chosen).toBeDefined();
    const body = chosen.response.result.data as WorldSlice;
    expect(validateWorldSlice(body).ok).toBe(true);
    expect(body.tokens).toBe(packetTokens(JSON.stringify(body)));
    expect(body.constraints[0]!.relation.perspective.mode).toBe("reported");
    expect(body.constraints[0]!.relation.valid.kind).toBe("known");
    expect(body.constraints[0]!.evidence.length).toBeGreaterThan(0);
    expect(body.detail).toEqual([]);
    const retained = { ...input, budgetTokens: chosen.budgetTokens, priorView: chosen.response.result.view };
    expect(serveWorldView(ctx, retained).data).toMatchObject({ result: { status: "unchanged" } });
    const stranger = addAgent(f.db, "slice-stranger", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:bayes"] });
    expect(serveWorldView({ ...ctx, principal: authenticate(f.db, stranger.token)! }, retained).data).toMatchObject({ result: { status: "new_view_required" } });
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "slice-revoke" });
    expect(serveWorldView(ctx, retained).data).toMatchObject({ result: { status: "new_view_required" } });
  } finally { f.dispose(); }
}, 120_000);

test("mandatory overflow is explicit and unretained; history is never an empty current slice", async () => {
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    for (let i = 0; i < 3; i++) await f.write("concept.counterexample", { kind: "literal", value: `Constraint ${i}: do not omit its qualifications.` });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const input = { operation: "slice", task: "Review", kinds: ["concept"], budgetTokens: 700, ...when };
    const result = serveWorldView(f.ctx, input).data;
    expect(result).toMatchObject({ result: { status: "incomplete", reasons: expect.arrayContaining(["required_context_overflow"]), data: { complete: false, truncated: true, constraints: [], detail: [] } } });
    expect(packetTokens(JSON.stringify(result))).toBeLessThanOrEqual(700);
    expect(result).not.toHaveProperty("result.view");
    expect(serveWorldView(f.ctx, { ...input, knownAt: { kind: "time", at: "2026-01-01T00:00:00Z" } }).data).toMatchObject({ result: { status: "unavailable", reason: "history" } });
  } finally { f.dispose(); }
});

test("slice advertises unlanded providers and never calls an impossible 80-token response complete", async () => {
  const scene = await verificationScene();
  try {
    const missing = serveWorldView(scene.reader, { operation: "slice", task: "Review", kinds: ["forecast"], budgetTokens: 2000, ...when });
    expect(missing.data).toMatchObject({ result: { status: "incomplete", data: { complete: false, providers: [{ kind: "forecast", status: "unavailable", reason: "not_landed" }] } } });
    const tiny = serveWorldView(scene.reader, { operation: "slice", task: "Review", kinds: ["situation"], budgetTokens: 80, ...when });
    expect(tiny.data).toMatchObject({ result: { status: "unavailable", reason: "budget" } });
    expect(packetTokens(JSON.stringify(tiny.data))).toBeLessThanOrEqual(80);
  } finally { scene.dispose(); }
});
