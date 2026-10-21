import { expect, spyOn, test } from "bun:test";
import * as sessionProjection from "../../src/world/slice/session";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { serveContextPacketV2 } from "../../src/serving/packet";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { budget } from "../canon/helpers";
import { serveCorrect } from "../../src/serving/correct";
import { readCurrentSituations } from "../../src/world/situations";
import { sourceCoverage } from "../../src/world/coverage";
import { serveWorldView } from "../../src/serving/world-view";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import type { SliceItem, WorldSlice } from "../../src/contracts/world-slice";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { cardFixture } from "./card-fixture";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";

const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const options = { model: EMPTY_SUMMARY_MODEL, purposes: ["capture", "derive", "recall", "session", "export", "correction"] as const };
async function fixture() {
  const f = await cardFixture(undefined, { ...options, purposes: [...options.purposes] });
  const subject = "project:launch";
  await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
  await f.write("situation.label", { kind: "literal", value: "Launch" }, { subject });
  await f.write("situation.blocker", { kind: "literal", value: "The independent review is still required." }, { subject, mode: "reported", holder: "person:ada" });
  return f;
}
function sessionItems(body: string): SliceItem[] {
  return body.split("\n").filter(line => line.includes(" :: slice ")).map(line => JSON.parse(line.split(" :: slice ")[1]!));
}
test("session v2 and task slices compile the same complete qualified constraint and evidence", async () => {
  const f = await fixture();
  try {
    await f.write("situation.change", { kind: "literal", value: "Optional detail ".repeat(20).trim() }, { subject: "project:launch" });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const slice = serveWorldView(f.ctx, { operation: "slice", task: "Resume launch", kinds: ["situation"], budgetTokens: 2000, ...when }).data;
    if (!("result" in slice) || !("data" in slice.result)) throw new Error("slice missing");
    const data = slice.result.data as WorldSlice;
    const response = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    if (!response.data || !("data" in response.data.result)) throw new Error("session missing");
    const packet = response.data.result.data;
    const actual = sessionItems(packet.packetMd);
    const constraint = data.constraints.find(item => item.relation.predicate === "situation.blocker")!;
    expect(constraint).toBeDefined();
    expect(actual.find(item => item.relation.predicate === "situation.blocker")).toEqual(constraint);
    expect(constraint.relation.perspective.mode).toBe("reported");
    expect(constraint.evidence.length).toBeGreaterThan(0);
    expect(packet.packetMd).toContain("## uncertain");
    expect(packet.tokens).toBe(packetTokens(packet.packetMd));
    expect(packet.tokens).toBeLessThanOrEqual(2000);
    expect(response.canon).toEqual([]);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "slice-session-revoke" });
    const revoked = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    expect(JSON.stringify(revoked)).not.toContain("The independent review is still required.");
  } finally { f.dispose(); }
}, 120_000);

test("session v2 never calls unfinished extraction or an unfit mandatory context current", async () => {
  const f = await fixture();
  try {
    expect(sourceCoverage({ ...f.ctx, sourcePurpose: "session" })).toContain("pending_consolidation");
    const pending = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    expect(pending.data).toHaveProperty("result.status", "incomplete");
    expect(pending.data).toHaveProperty("result.data.coverage.status", "partial");
    expect(pending.data).toHaveProperty("result.data.coverage.gaps", ["coverage"]);
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const small = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 450 });
    expect(small.data).toMatchObject({ result: { status: "incomplete", data: { coverage: { status: "partial", gaps: expect.arrayContaining(["required_context_overflow"]) } } } });
    if (!small.data || !("data" in small.data.result)) throw new Error("session missing");
    expect(sessionItems(small.data.result.data.packetMd)).toEqual([]);
    expect(small.data.result.data.tokens).toBeLessThanOrEqual(450);
    expect(small.data.result.data.packetMd).toContain("coverage=incomplete; missing context must not be treated as absent\n");
    expect(small.data.result.data.tokens).toBe(packetTokens(small.data.result.data.packetMd));
    expect(small.data.result).not.toHaveProperty("view");
  } finally { f.dispose(); }
}, 120_000);


for (const completedBefore of [false, true]) test(`summary-free session retains a native correction with prior summary=${completedBefore}`, async () => {
  const f = await cardFixture(undefined, { ...(completedBefore ? { model: EMPTY_SUMMARY_MODEL } : {}), purposes: [...options.purposes] });
  try {
    const subject = "project:launch";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
    await f.write("situation.label", { kind: "literal", value: "Launch" }, { subject });
    const initial = await f.write("situation.blocker", { kind: "literal", value: "Waiting for initial review." }, { subject });
    if (initial.stored.outcome !== "stored") throw new Error("blocker not stored");
    applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, [initial.stored.claim],
      worldCanonTarget(f.db, initial.stored.claim.claim_id), { writer: "loop", budget: budget() });
    if (completedBefore) await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const before = readCurrentSituations(f.ctx, { limit: 4, canRead: () => true })[0]!;
    const corrected = await serveCorrect(f.ctx, { statement: "Waiting for independent verification.",
      target: { world_claim: before.card.blocker!.claim }, mode: "replace_object",
      object: { kind: "literal", value: "Waiting for independent verification." } });
    expect(corrected.data?.receipt_id).toBeString();
    expect(sourceCoverage({ ...f.ctx, sourcePurpose: "session" })).toEqual([]);
    const state = readCurrentSituations(f.ctx, { limit: 4, canRead: () => true })[0]!;
    expect(state.card.coverage.gaps).toContain("coverage");
    expect(state.card.coverage.gaps.some(gap => gap === "pending_consolidation" || gap === "stale_dependencies")).toBe(true);
    const response = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    expect(response.data, JSON.stringify(response.data)).toHaveProperty("result.status", "current");
    if (!response.data || !("data" in response.data.result)) throw new Error("session missing");
    const packet = response.data.result.data;
    const blocker = sessionItems(packet.packetMd).find(item => item.relation.predicate === "situation.blocker")!;
    expect(blocker.relation.object).toEqual({ kind: "literal", value: "Waiting for independent verification." });
    expect(blocker.evidence.length).toBeGreaterThan(0);
    expect(packet.coverage.status).toBe("complete_for_query");
    expect(packet.tokens).toBeLessThanOrEqual(2000);
    expect(packet.packetMd).not.toContain("Waiting for initial review.");
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "session-correction-revoke" });
    const revoked = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    if (!revoked.data || !("data" in revoked.data.result)) throw new Error("revoked session missing");
    // The imported situation loses authority. The independently captured owner
    // correction remains readable as quoted evidence, not as a current relation.
    expect(sessionItems(revoked.data.result.data.packetMd)).toEqual([]);
    expect(revoked.canon).toEqual([]);
    expect(revoked.quoted).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventVersion: expect.objectContaining({kind: "event_version"}), text: "Waiting for independent verification.", tainted: true }),
    ]));
  } finally { f.dispose(); }
}, 120_000);


test("session overflow keeps only whole qualified relations while public slices withhold all mandatory context", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 4; index++) {
      await f.write("situation.blocker", { kind: "literal", value: `Independent qualification ${index} must retain its evidence.` },
        { subject: "project:launch", mode: "reported", holder: "person:ada" });
    }
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const response = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    if (!response.data || !("data" in response.data.result)) throw new Error("session missing");
    const packet = response.data.result.data;
    expect(response.data.result.status).toBe("incomplete");
    expect(packet.coverage.gaps).toContain("required_context_overflow");
    expect(packet.packetMd).toContain("coverage=incomplete; missing context must not be treated as absent\n");
    const items = sessionItems(packet.packetMd);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(5);
    expect(packet.servedUnits).toBe(items.length + response.quoted.length + response.canon.length);
    expect(items[0]!.relation.perspective.mode).toBe("reported");
    expect(items[0]!.evidence.length).toBeGreaterThan(0);
    expect(packet.tokens).toBe(packetTokens(packet.packetMd));
    expect(packet.tokens).toBeLessThanOrEqual(2000);
    expect(response.data.result).not.toHaveProperty("view");
    const slice = serveWorldView(f.ctx, { operation: "slice", task: "Resume launch", kinds: ["situation"], budgetTokens: 2000, ...when }).data;
    if (!("result" in slice) || !("data" in slice.result)) throw new Error("slice missing");
    expect(slice.result.status).toBe("incomplete");
    expect((slice.result.data as WorldSlice).constraints).toEqual([]);
    expect((slice.result.data as WorldSlice).coverage.gaps).toContain("required_context_overflow");
  } finally { f.dispose(); }
}, 120_000);

test("query ranking preserves whole card-level uncertainty and revocation under session overflow", async () => {
  const f = await fixture();
  try {
    const subject = "project:launch", objective = "Restore the orchard footbridge.";
    await f.write("situation.objective", { kind: "literal", value: objective }, { subject });
    await f.write("situation.objective", { kind: "literal", value: "The flood estimate is unverified." }, { subject, mode: "uncertain" });
    for (let index = 0; index < 4; index++) {
      await f.write("situation.commitment", { kind: "literal", value: `Deliver independent survey ${index}.` }, { subject });
    }
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const state = readCurrentSituations(f.ctx, { limit: 4, canRead: () => true, projection: "relations" })[0]!;
    const ambiguous = state.card.uncertainty.find(relation => relation.object.kind === "literal" && relation.object.value === objective)!;
    expect(ambiguous).toBeDefined();
    expect(ambiguous.perspective).toMatchObject({ mode: "asserted", interpretation: "explicit" });
    expect(ambiguous.conflict).toBe("none_observed");
    const args = { purpose: "session", budget_tokens: 2000, query: "orchard footbridge" } as const;
    const response = await serveContextPacketV2(f.ctx, args);
    if (!response.data || !("data" in response.data.result)) throw new Error("session missing");
    const packet = response.data.result.data;
    expect(response.data.result.status).toBe("incomplete");
    expect(packet.coverage.gaps).toContain("required_context_overflow");
    const item = sessionItems(packet.packetMd).find(one => one.relation.claim.token === ambiguous.claim.token)!;
    expect(item).toBeDefined();
    expect(item.relation).toEqual(ambiguous);
    expect(item.evidence.length).toBeGreaterThan(0);
    expect(packet.packetMd).toContain("## uncertain (Situation card; quoted data)");
    expect(packet.packetMd).toContain("coverage=incomplete; missing context must not be treated as absent\n");
    expect(packet.tokens).toBe(packetTokens(packet.packetMd));
    expect(packet.tokens).toBeLessThanOrEqual(2000);
    const again = await serveContextPacketV2(f.ctx, args);
    expect(again.data).toHaveProperty("result.data.packetMd", packet.packetMd);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "session-ranked-revoke" });
    const revoked = await serveContextPacketV2(f.ctx, args);
    expect(JSON.stringify(revoked)).not.toContain(objective);
  } finally { f.dispose(); }
}, 120_000);

test("typed session failure preserves independently authorized capture and reports unavailable sections", async () => {
  const f = await fixture();
  const at = new Date().toISOString();
  const stored = accept(f.db, { ...validEvent(), connector_id: "card.fixture", source_record_id: "independent-session-capture",
    occurred_at: at, observed_at: at, text: "Independent captured note remains quoted.", sensitivity_hint: "public" },
    { source: { source_key: f.sourceKey, expected_revision: 1 } });
  expect(stored.status).toBe("stored");
  const projection = spyOn(sessionProjection, "compileSessionSlice").mockImplementation(() => { throw new Error("synthetic projection failure"); });
  try {
    const response = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    if (!response.data || !("data" in response.data.result)) throw new Error("session missing");
    const packet = response.data.result.data;
    expect(projection).toHaveBeenCalledTimes(1);
    expect(response.data.result.status).toBe("incomplete");
    expect(packet.packetMd).toContain("coverage=incomplete; missing context must not be treated as absent\n");
    expect(packet.packetMd).toContain("Independent captured note remains quoted.");
    expect(packet.packetMd).not.toContain("synthetic projection failure");
    expect(sessionItems(packet.packetMd)).toEqual([]);
    expect(packet.coverage).toMatchObject({status: "partial", gaps: ["coverage"]});
    expect(packet.servedUnits).toBe(response.quoted.length);
    expect(response.quoted).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Independent captured note remains quoted.", tainted: true })]));
    expect(packet.tokens).toBe(packetTokens(packet.packetMd));
    expect(packet.tokens).toBeLessThanOrEqual(2000);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "session-failed-projection-revoke" });
    const revoked = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    expect(JSON.stringify(revoked)).not.toContain("Independent captured note remains quoted.");
    expect(revoked.data).toHaveProperty("result.data.servedUnits", 0);
  } finally { projection.mockRestore(); f.dispose(); }
}, 120_000);
