import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { expect, setSystemTime, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { personFixture, ADA, BEN, PERSON_WHEN as WHEN } from "../helpers/person-fixture";

test("a permitted Person reveals neither a restricted connected person nor the work of hidden attribution", async () => {
  const f = await personFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    const agent = addAgent(f.db, "person-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: [ADA] });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const ref = f.findPerson("Ada", reader);
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const request = { operation: "person", person: ref, ...WHEN };
    expect(serveWorldView(reader, request).data).toMatchObject({ result: { status: "incomplete", data: { coverage: { gaps: expect.arrayContaining(["pending_consolidation"]) } } } });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const initial = serveWorldView(reader, request).data;
    if (!("result" in initial) || initial.result.status !== "current") throw new Error("Person view missing");
    const input = { ...request, priorView: initial.result.view };
    const observe = () => collectReadFrames(() => serveWorldView(reader, input));
    const before = observe();
    await f.write("relationship.with", { kind: "subject", ref: f.ref(BEN) }, { subject: ADA });
    await f.write("person.role", { kind: "literal", value: "Secret reviewer" }, { subject: ADA, speaker: BEN, holder: BEN, mode: "quoted" });
    // These raw records also name permitted ADA, so their extraction backlog is visible.
    // Once consumed, the hidden BEN semantics must not change the retained Person view.
    expect(serveWorldView(reader, request).data).toMatchObject({ result: { status: "incomplete", reasons: ["pending_consolidation"] } });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const after = observe();
    expect(after.result.data).toEqual(before.result.data);
    expect(after.result.quoted).toEqual(before.result.quoted);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(JSON.stringify(after.result)).not.toContain("Secret reviewer");
    expect(f.readPerson().relationships).toHaveLength(1);
    const discovery = serveWorldView(reader, { operation: "find_people", ...WHEN }).data;
    expect(discovery).toMatchObject({ result: { data: { matches: [{ labels: ["Ada"] }] } } });
    const copied = serveWorldView(reader, { operation: "person", person: f.findPerson("Ben"), ...WHEN }).data;
    const unknown = serveWorldView(reader, { operation: "person", person: { kind: "object", token: "A".repeat(43) }, ...WHEN }).data;
    expect(copied).toEqual(unknown);
  } finally { setSystemTime(); f.dispose(); }
}, 120_000);

test.each(["revocation", "purge"])("%s invalidates Person views and never returns the old quotes", async cause => {
  const f = await personFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const request = { operation: "person", person: f.personRef, ...WHEN };
    const before = serveWorldView(f.ctx, request).data;
    if (!("result" in before) || before.result.status !== "current") throw new Error("person baseline missing");
    if (cause === "revocation") revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "person-revoke" });
    else {
      const events = f.db.query<{ event_id: string }, [string]>(`SELECT DISTINCT se.event_id FROM claim_v2_semantics c JOIN claim_v2_support s USING(claim_id)
        JOIN claim_v2_support_events se USING(support_key) WHERE c.subject_id=? AND c.predicate='world.kind'`).all(ADA);
      expect(events).toHaveLength(1);
      purgeEvents(f.db, f.ctx.vaultPath, { event_id: events[0]!.event_id }, "person-purge");
    }
    expect(serveWorldView(f.ctx, request).data).toEqual({ status: "not_found" });
    const lost = serveWorldView(f.ctx, { ...request, priorView: before.result.view });
    expect(lost.data).toMatchObject({ result: { status: "new_view_required" } });
    expect(lost.quoted).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);
