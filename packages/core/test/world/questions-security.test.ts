import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { questionFixture, QUESTION, QUESTION_WHEN as WHEN } from "../helpers/question-fixture";

test("hidden Questions and gaps change neither a restricted frontier nor its work", async () => {
  const f = await questionFixture();
  try {
    const agent = addAgent(f.db, "question-reader", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: [QUESTION, "topic:bayes"] });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const about = f.find(ctx);
    const input = { operation: "frontier", about, ...WHEN };
    const observe = () => collectReadFrames(() => serveWorldView(ctx, input).data);
    const before = observe();
    await f.writeQuestion("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject: "question:hidden" });
    await f.writeQuestion("question.text", { kind: "literal", value: "Private missing information" }, { subject: "question:hidden" });
    await f.writeQuestion("gap.about", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "question:hidden" });
    await f.writeQuestion("gap.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "gap/misconception" } }, { subject: "question:hidden" });
    const after = observe();
    expect(after.result).toEqual(before.result);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(JSON.stringify(after.result)).not.toContain("Private missing information");
    expect(JSON.stringify(serveWorldView(f.ctx, { operation: "frontier", ...WHEN }).data)).toContain("misconception");
  } finally { f.dispose(); }
}, 120_000);

test.each(["revocation", "purge"])("%s removes Question and frontier evidence at the next consumer read", async cause => {
  const f = await questionFixture();
  try {
    const request = { operation: "question", question: f.questionRef, ...WHEN };
    const before = serveWorldView(f.ctx, request).data;
    if (!("result" in before) || before.result.status !== "current") throw new Error("missing baseline");
    if (cause === "revocation") revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "question-revoke" });
    else {
      const events = f.db.query<{ event_id: string }, [string]>(`SELECT DISTINCT se.event_id FROM claim_v2_semantics c
        JOIN claim_v2_support s USING(claim_id) JOIN claim_v2_support_events se USING(support_key)
        WHERE c.subject_id=? AND c.predicate='world.kind'`).all(QUESTION);
      expect(events).toHaveLength(1);
      for (const event of events) purgeEvents(f.db, f.ctx.vaultPath, { event_id: event.event_id }, "question-purge");
    }
    expect(serveWorldView(f.ctx, request).data).toEqual({ status: "not_found" });
    expect(serveWorldView(f.ctx, { ...request, priorView: before.result.view }).data).toMatchObject({ result: { status: "new_view_required" } });
    expect(serveWorldView(f.ctx, { operation: "frontier", ...WHEN }).data).toMatchObject({ result: { data: { groups: [] } } });
  } finally { f.dispose(); }
}, 120_000);

test("the about restriction is applied before the discovery page limit", async () => {
  const f = await questionFixture();
  try {
    for (let i = 0; i < 40; i++) {
      const subject = `question:unrelated:${i}`;
      await f.writeQuestion("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/question" } }, { subject });
      await f.writeQuestion("question.text", { kind: "literal", value: `Unrelated question ${i}` }, { subject });
    }
    const all = serveWorldView(f.ctx, { operation: "find_questions", ...WHEN }).data;
    expect(all).toMatchObject({ result: { data: { matches: expect.any(Array) } } });
    const scoped = serveWorldView(f.ctx, { operation: "find_questions", about: f.find(), ...WHEN }).data;
    expect(scoped).toMatchObject({ result: { data: { matches: [{ ref: f.questionRef }], cursor: null } } });
    const absent = { kind: "object", token: "A".repeat(43) };
    expect(serveWorldView(f.ctx, { operation: "find_questions", about: absent, ...WHEN }).data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
}, 120_000);
