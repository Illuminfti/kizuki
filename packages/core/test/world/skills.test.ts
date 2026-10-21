import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { servePropose } from "../../src/serving/propose";
import { serveCorrect } from "../../src/serving/correct";
import { validateProcedureCard } from "../../src/contracts/procedure-card";
import { activeWorldRegistry } from "../../src/contracts/world-vocabulary";
import { skillFixture, PROCEDURE, SKILL, FRAMEWORK, WHEN } from "../helpers/skill-fixture";

test("procedure retains four dimensions, quoted hostile steps and counterexamples; retrieval never changes evidence", async () => {
  const f = await skillFixture();
  try {
    const before = f.readProcedure();
    expect(validateProcedureCard(before).ok).toBe(true);
    expect(before.steps[0]!.kind).toBe("quoted");
    expect(before.executionAuthority).toBe("none");
    expect(before.taskUsefulness).toEqual({ status: "unknown", reason: "no_outcome_evidence" });
    expect(before.applicability.counterexamples).toHaveLength(1);
    expect(before.freshness).toMatchObject({ status: "recorded", lastValidated: [{ object: { kind: "literal", value: "2026-10-20T00:00:00.000Z" } }] });
    expect(before.standards).toHaveLength(1);
    expect(before.exemplars).toHaveLength(1);
    for (let i = 0; i < 5; i++) { f.findProcedure(); expect(f.readProcedure()).toEqual(before); }
    expect(validateProcedureCard({ ...before, score: 1 }).ok).toBe(false);
    const skill = f.payload({ operation: "skill", skill: f.skillRef });
    expect(skill).toMatchObject({ selfReport: expect.any(Array), exposure: expect.any(Array), explanation: expect.any(Array), application: expect.any(Array), observedOutcome: expect.any(Array), mastery: "unknown" });
    for (const kind of ["skill","framework","procedure"]) expect(activeWorldRegistry().kind(kind)!.offeredToProducer).toBe(false);
  } finally { f.dispose(); }
}, 120_000);

test("nested frameworks retain node structure and cycles are refused at write and read", async () => {
  const f = await skillFixture();
  try {
    const card = f.payload({ operation: "framework", framework: f.frameworkRef });
    if (card.schema !== "kizuki.framework-card/v1") throw new Error("missing framework");
    const child = card.components[0]!.object;
    expect(child.kind).toBe("node");
    if (child.kind !== "node") throw new Error("lost nesting");
    expect(f.payload({ operation: "framework", framework: child.ref })).toMatchObject({ framework: { labels: [{ text: "framework:inspection" }] }, components: [] });
    const cyclic = () => f.writeKnowledge("framework.includes", { kind: "subject", ref: f.ref(FRAMEWORK) }, { subject: "framework:inspection" });
    const count = f.db.query<{n:number},[]>("SELECT count(*) n FROM claims").get()!.n;
    await expect(cyclic()).rejects.toThrow("world_cycle");
    expect(f.db.query<{n:number},[]>("SELECT count(*) n FROM claims").get()!.n).toBe(count);
    // Simulate a legacy restore containing a cycle without weakening the writer check.
    const edge = f.db.query<{claim_id:string},[]>("SELECT claim_id FROM claim_v2_semantics WHERE predicate='framework.includes'").get()!.claim_id;
    f.db.query("UPDATE claims SET status='superseded' WHERE claim_id=?").run(edge);
    await cyclic();
    f.db.query("UPDATE claims SET status='live' WHERE claim_id=?").run(edge);
    expect(serveWorldView(f.ctx, { operation: "framework", framework: f.frameworkRef, ...WHEN }).data).toMatchObject({ result: { status: "unavailable", reason: "storage" } });
  } finally { f.dispose(); }
}, 120_000);

test("independent observed and reviewed outcomes change scoped usefulness without changing truth or assisted mastery", async () => {
  const f = await skillFixture();
  try {
    const truth = f.readProcedure().evidenceStrength;
    const report = await f.file(0, "outcome.self_report");
    const replay = await servePropose(report.ctx, report.input);
    expect(replay.data!.outcome).toBe("duplicate");
    await f.file(0, "outcome.provider_ack", { result: "acknowledged" });
    expect(f.payload({ operation: "outcome", subject: PROCEDURE })).toMatchObject({ goalAchieved: false, evaluations: [{ result: "unknown" }] });
    await f.file(0, "outcome.observation");
    await f.file(1, "outcome.observation", {}, { metadata: { forwarded_from: "report" } });
    await f.file(2, "outcome.review", { result: "accepted" });
    expect(f.readProcedure().taskUsefulness.status).toBe("unknown");
    await f.file(1, "outcome.observation");
    const useful = f.readProcedure();
    expect(useful.taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "met", goalAchieved: true, independentMastery: false }] });
    expect(useful.evidenceStrength).toEqual(truth);
    expect(f.payload({ operation: "outcome", subject: PROCEDURE })).toMatchObject({ goalAchieved: true });
    await f.file(2, "outcome.review", { result: "pending" });
    expect(f.payload({ operation: "outcome", subject: PROCEDURE })).toMatchObject({ goalAchieved: false, evaluations: [{ result: "unknown" }] });
  } finally { f.dispose(); }
}, 120_000);

test("artifact versions, failed inspections and confounders cannot be rewritten by later successes", async () => {
  const f = await skillFixture();
  try {
    await f.file(0, "outcome.self_report");
    await f.file(1, "outcome.observation", { result: "not_met" });
    await f.file(2, "outcome.review", { result: "rejected" });
    await f.file(1, "outcome.observation", { artifactVersion: "artifact-2" });
    await f.file(2, "outcome.review", { result: "accepted", artifactVersion: "artifact-2" });
    expect(f.readProcedure().taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "not_met", goalAchieved: false }] });
    await f.file(0, "outcome.self_report", { attempt: "attempt-2", confounded: true });
    await f.file(1, "outcome.observation", { attempt: "attempt-2", confounded: true });
    await f.file(2, "outcome.review", { attempt: "attempt-2", result: "accepted", confounded: true });
    const outcome = f.payload({ operation: "outcome", subject: PROCEDURE });
    expect(outcome).toMatchObject({ evaluations: [{ result: "not_met" }, { result: "unknown" }], goalAchieved: false });
    expect(f.readProcedure().taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "not_met" }, { result: "unknown" }] });
  } finally { f.dispose(); }
}, 120_000);

test("known-time procedures retain old steps, owner correction changes current knowledge, and historical usefulness stays honest", async () => {
  const f = await skillFixture();
  try {
    const at = "2030-01-09T00:00:00.000Z";
    f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(at);
    const old = f.payload({ operation: "procedure", procedure: f.procedureRef, knownAt: { kind: "time", at } });
    expect(old).toMatchObject({ taskUsefulness: { status: "unknown", reason: "history" } });
    await serveCorrect(f.ctx, { statement: "Inspect safely instead.", target: { world_claim: f.readProcedure().steps[0]!.assertion.claim }, mode: "replace_object", object: { kind: "literal", value: "Inspect safely." } });
    expect(f.readProcedure().steps[0]!.assertion.object).toEqual({ kind: "literal", value: "Inspect safely." });
    if (old.schema !== "kizuki.procedure-card/v1") throw new Error("missing procedure");
    expect(f.payload({ operation: "procedure", procedure: f.procedureRef, knownAt: old.knownAt })).toEqual(old);
  } finally { f.dispose(); }
}, 120_000);

test("repeated reports remain one logical evaluation and legacy reached/missed stay self reports", async () => {
  const f = await skillFixture();
  try {
    await f.file(0, "outcome.self_report", { assistance: "unassisted" });
    await f.file(0, "outcome.self_report", { assistance: "unassisted" });
    await f.file(1, "outcome.observation", { assistance: "unassisted" });
    await f.file(2, "outcome.review", { result: "accepted", assistance: "unassisted" });
    const outcome = f.payload({ operation: "outcome", subject: PROCEDURE });
    expect(outcome).toMatchObject({ evaluations: [{ result: "met", independentMastery: false }] });
    if (outcome.schema !== "kizuki.outcome-card/v1") throw new Error("missing outcome");
    expect(outcome.evaluations).toHaveLength(1);
    await f.file(0, "outcome.reached");
    await f.file(0, "outcome.missed");
    const legacy = f.payload({ operation: "outcome", subject: PROCEDURE });
    if (legacy.schema !== "kizuki.outcome-card/v1") throw new Error("missing outcome");
    expect(legacy.stages.filter(e => e.evidence === null).every(e => e.stage === "agent_reported" && !e.independent)).toBe(true);
    expect(legacy.evaluations.filter(e => e.conditions === null).every(e => !e.goalAchieved)).toBe(true);
  } finally { f.dispose(); }
}, 120_000);


test("different source and principal, exact scope pins and immutable text roots are all required", async () => {
  const f = await skillFixture();
  try {
    const report = await f.file(0, "outcome.self_report", {}, { text: "identical copied inspection evidence" });
    // Different principal but the reporter's event is the same provenance source.
    await servePropose(f.agents[1]!.ctx, { ...report.input, predicate: "outcome.observation", body: "same source observer", object: JSON.stringify({ ...f.base, subjectRef: f.findProcedure(f.agents[1]!.ctx).token }) });
    await f.file(2, "outcome.review", { result: "accepted" });
    await f.file(1, "outcome.observation", {}, { text: "identical copied inspection evidence" });
    for (const patch of [{ task: "other" }, { attempt: "other" }, { criterion: "other" }, { artifactVersion: "other" }, { environment: "other" }, { assistance: "unassisted" as const }])
      await f.file(1, "outcome.observation", patch);
    expect(f.readProcedure().taskUsefulness).toEqual({ status: "unknown", reason: "no_outcome_evidence" });
    const before = f.payload({ operation: "outcome", subject: PROCEDURE });
    if (before.schema !== "kizuki.outcome-card/v1") throw new Error("missing outcome");
    expect(before.evaluations[0]!.result).toBe("unknown");
    expect(before.stages.every(stage => stage.evidence?.subjectRef === "bound")).toBe(true);
    const stored = f.db.query<{ object: string }, []>("SELECT object FROM claims WHERE predicate='outcome.self_report' AND status='live'").get()!;
    expect(JSON.stringify(before)).not.toContain(JSON.parse(stored.object).subjectRef);
    await f.file(1, "outcome.observation");
    expect(f.readProcedure().taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "met" }] });
  } finally { f.dispose(); }
}, 120_000);


test("skill observed-outcome claims require matching independent outcome provenance; steps keep numeric order", async () => {
  const f = await skillFixture();
  try {
    expect(f.payload({ operation: "skill", skill: f.skillRef })).toMatchObject({ selfReport: expect.any(Array), observedOutcome: [], taskUsefulness: { status: "unknown", reason: "no_outcome_evidence" } });
    const token = (index: number) => {
      const object = f.readProcedure(f.agents[index]!.ctx).applicability.requiredCapabilities[0]!.object;
      if (object.kind !== "node") throw new Error("missing skill token");
      return object.ref.token;
    };
    await f.file(0, "outcome.self_report", { subjectRef: token(0) }, { subject: SKILL });
    await servePropose(f.agents[1]!.ctx, { kind: "claim", subject: SKILL, subjects: [SKILL], predicate: "outcome.observation", body: "Independent skill observation", provenance: [f.skillEvidence.get("observed_outcome")!.event.event_id], object: JSON.stringify({ ...f.base, subjectRef: token(1) }) });
    await f.file(2, "outcome.review", { subjectRef: token(2), result: "accepted" }, { subject: SKILL });
    const skill = f.payload({ operation: "skill", skill: f.skillRef });
    if (skill.schema !== "kizuki.skill-card/v1") throw new Error("missing skill");
    expect(skill.observedOutcome).toHaveLength(1);
    expect(skill.selfReport).toHaveLength(1);
    expect(skill.mastery).toBe("unknown");
    expect(skill.taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "met" }] });
    await f.writeKnowledge("procedure.step", { kind: "literal", value: "10. Finish inspection." });
    await f.writeKnowledge("procedure.step", { kind: "literal", value: "2. Inspect required fields." });
    expect(f.readProcedure().steps.slice(0, 2).map(step => step.assertion.object)).toEqual([{ kind: "literal", value: "2. Inspect required fields." }, { kind: "literal", value: "10. Finish inspection." }]);
    await expect(f.writeKnowledge("procedure.last_validated", { kind: "literal", value: "yesterday" })).rejects.toThrow("world_vocabulary_value");
  } finally { f.dispose(); }
}, 120_000);
