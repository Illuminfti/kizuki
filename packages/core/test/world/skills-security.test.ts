import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "../../src/serving/world-view";
import { servePropose } from "../../src/serving/propose";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { skillFixture, PROCEDURE, WHEN } from "../helpers/skill-fixture";

test("hidden outcomes affect neither procedure bytes nor projection work; denial leaves claims unchanged", async () => {
  const f = await skillFixture();
  try {
    const grant = { ...OWNER_AGENT_GRANT, subjects: [PROCEDURE, "topic:bayes", "skill:inspection", "framework:quality"] };
    const agent = addAgent(f.db, "narrow", grant), ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const ref = f.findProcedure(ctx);
    const initial = serveWorldView(ctx, { operation: "procedure", procedure: ref, ...WHEN }).data;
    if (!("result" in initial) || initial.result.status !== "current") throw new Error("missing view baseline");
    const observe = () => collectReadFrames(() => serveWorldView(ctx, { operation: "procedure", procedure: ref, priorView: initial.result.status === "current" ? initial.result.view : undefined, ...WHEN }).data);
    const before = observe();
    await f.file(0, "outcome.self_report", { subjectRef: "none" }, { subject: "private:task" });
    const after = observe();
    expect(after.result).toEqual(before.result);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    const filed = await f.file(0, "outcome.self_report");
    const count = f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n;
    const deniedBefore = f.db.query<{ n: number }, []>("SELECT count(*) n FROM agent_audit WHERE tool='propose' AND denied_count>0").get()!.n;
    const noPropose = addAgent(f.db, "read-only", { ...grant, tools: ["world_view"] });
    for (const [reader, input] of [[{ ...f.ctx, principal: authenticate(f.db, noPropose.token)! }, filed.input],
      [ctx, { ...filed.input, subject: "outside", subjects: ["outside"] }],
      [ctx, { ...filed.input, provenance: [] }], [ctx, { ...filed.input, object: JSON.stringify({ ...f.base, result: "met", extra: true }) }]] as const)
      await expect(servePropose(reader, input as any)).rejects.toThrow();
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims").get()!.n).toBe(count);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM agent_audit WHERE tool='propose' AND denied_count>0").get()!.n).toBe(deniedBefore + 4);
  } finally { f.dispose(); }
}, 120_000);

test.each(["purge", "revocation"])("%s removes outcome-derived usefulness on the next procedure read", async action => {
  const f = await skillFixture();
  try {
    await f.file(0, "outcome.self_report");
    const observation = await f.file(1, "outcome.observation");
    await f.file(2, "outcome.review", { result: "accepted" });
    expect(f.readProcedure().taskUsefulness.status).toBe("observed");
    const before = serveWorldView(f.ctx, { operation: "procedure", procedure: f.procedureRef, ...WHEN }).data;
    if (action === "purge") purgeEvents(f.db, f.ctx.vaultPath, { event_id: observation.event.event_id }, "outcome-purge");
    else revokeSourceGrant(f.db, { source_key: f.agents[1]!.sourceKey, expected_revision: 1, operation_id: "outcome-revoke" });
    expect(f.readProcedure().taskUsefulness).toEqual({ status: "unknown", reason: "no_outcome_evidence" });
    if ("result" in before && before.result.status === "current") {
      const later = serveWorldView(f.ctx, { operation: "procedure", procedure: f.procedureRef, priorView: before.result.view, ...WHEN }).data;
      expect(later).toMatchObject({ result: { status: "new_view_required" } });
    }
  } finally { f.dispose(); }
}, 120_000);
