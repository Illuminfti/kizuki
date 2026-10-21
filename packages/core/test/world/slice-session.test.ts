import { expect, test } from "bun:test";
import { serveContextPacketV2 } from "../../src/serving/packet";
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
    const pending = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 2000 });
    expect(pending.data).toHaveProperty("result.status", "incomplete");
    expect(JSON.stringify(pending.data)).toContain("pending_consolidation");
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const small = await serveContextPacketV2(f.ctx, { purpose: "session", budget_tokens: 450 });
    expect(small.data).toMatchObject({ result: { status: "incomplete", data: { truncated: true, retrievalDegraded: expect.arrayContaining(["required_context_overflow"]) } } });
    if (!small.data || !("data" in small.data.result)) throw new Error("session missing");
    expect(sessionItems(small.data.result.data.packetMd)).toEqual([]);
    expect(small.data.result.data.tokens).toBeLessThanOrEqual(450);
    expect(small.data.result).not.toHaveProperty("view");
  } finally { f.dispose(); }
}, 120_000);
