import { servePropose } from "../../src/serving/propose";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { runPurge } from "../../src/ledger/purge";
import { readOutcomes } from "../../src/world/outcomes";
import { outcomeArtifactBinding } from "../../src/world/outcome-binding";
import { worldNamespace, resolveWorldObject } from "../../src/world/references";
import { readWorldCard } from "../../src/world/pipeline/read";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { worldDependencies, worldDependenciesCurrent } from "../../src/world/dependencies";
import { expect, test } from "bun:test";
import { artifactFixture } from "../helpers/artifact-fixture";
import { skillFixture, PROCEDURE } from "../helpers/skill-fixture";

test("an Outcome can explicitly bind a current ArtifactVersion through its caller ObjectRef", async () => {
  const f = await skillFixture(), artifacts = await artifactFixture(f.db);
  try {
    const artifact = await artifacts.capture("Exact deliverable bytes");
    const callerRef = artifact.ref(f.agents[0]!.ctx);
    const filed = await f.file(0, "outcome.self_report", { artifactVersion: callerRef }, {text:"Reporter recorded exact deliverable completion."});
    if (filed.result.data === undefined) throw new Error("outcome was not filed");
    expect(filed.result.data.outcome).toBe("stored");
    const stored = f.db.query<{object:string},[string]>("SELECT object FROM claims WHERE claim_id=?").get(filed.result.data.claim_id)!;
    expect(JSON.parse(stored.object).artifactVersion).toMatchObject({kind:"artifact_binding"});
    expect(stored.object).not.toContain(callerRef.token);
  } finally { artifacts.dispose(); f.dispose(); }
}, 120000);

for (const action of ["revoke", "purge"] as const) test(`authenticated outcomes match exact source/version and lose publication authority on ${action}`, async () => {
  const f = await skillFixture(), artifacts = await artifactFixture(f.db);
  try {
    const artifact = await artifacts.capture("Exact version qualified for completion");
    const otherSource = await artifacts.capture("Exact version qualified for completion");
    const otherVersion = await artifacts.capture("Different version qualified separately", "public", artifact.sourceKey);
    const refs = f.agents.map(agent => artifact.ref(agent.ctx));
    for (const [index, predicate] of ["outcome.self_report", "outcome.observation", "outcome.review"].entries())
      await f.file(index, predicate, { artifactVersion: refs[index]!, ...(index === 2 ? { result: "accepted" } : {}) }, {text:`Independent source ${index} reported the exact delivered file version.`});
    const binding = outcomeArtifactBinding(artifact.subject);
    expect(binding).not.toBe(outcomeArtifactBinding(otherSource.subject));
    expect(binding).not.toBe(outcomeArtifactBinding(otherVersion.subject));
    const deps = worldDependencies();
    const result = f.db.transaction(() => {
      const ns = worldNamespace(f.db, f.ctx.principal), frame = newReadFrame(f.ctx, ns, {kind:"all"}, deps);
      const card = readWorldCard(frame, resolveWorldObject(f.db, ns, artifact.ref().token)!, "artifact_version");
      expect(card?.schema).toBe("kizuki.artifact-card/v1");
      const correct = readOutcomes(frame, PROCEDURE, undefined, binding);
      expect(readOutcomes(frame, PROCEDURE, undefined, outcomeArtifactBinding(otherSource.subject)).goalAchieved).toBe(false);
      expect(readOutcomes(frame, PROCEDURE, undefined, outcomeArtifactBinding(otherVersion.subject)).goalAchieved).toBe(false);
      // Standalone cards quote the report without asserting current artifact completion.
      expect(readOutcomes(frame, PROCEDURE).goalAchieved).toBe(false);
      return correct;
    })();
    expect(result.goalAchieved).toBe(true);
    expect(result.evaluations[0]!.conditions?.artifactVersion).toBe("bound");
    expect(JSON.stringify(result)).not.toContain(binding);
    expect(deps.claims.size).toBeGreaterThan(0);
    expect(deps.legacyClaims.size).toBe(3);
    if (action === "revoke") revokeSourceGrant(f.db, {source_key:artifact.sourceKey, expected_revision:1, operation_id:"outcome-artifact-revoke"});
    else await runPurge(f.db, f.ctx.vaultPath, {event_id:artifact.event.event_id}, "outcome-artifact-purge");
    expect(f.db.transaction(() => worldDependenciesCurrent(f.ctx, deps))()).toBe(false);
    const prior = await f.file(0, "outcome.self_report", {artifactVersion:"legacy-unbound"});
    const input = {...prior.input, object:JSON.stringify({...JSON.parse(prior.input.object), artifactVersion:refs[0]})};
    await expect(servePropose(prior.ctx, input)).rejects.toThrow();
  } finally { artifacts.dispose(); f.dispose(); }
}, 120000);

test("Outcome ArtifactVersion rejects copied/denied refs, injected tags and revoke during preparation", async () => {
  const f = await skillFixture(), artifacts = await artifactFixture(f.db);
  try {
    const artifact = await artifacts.capture("Deliverable authority race");
    const who = f.agents[0]!, ref = artifact.ref(who.ctx), prior = await f.file(0,"outcome.self_report");
    const input = {...prior.input, body:"A separate version-bound report", object:JSON.stringify({...JSON.parse(prior.input.object), artifactVersion:ref})};
    const count = () => f.db.query<{n:number},[]>("SELECT count(*) n FROM claims").get()!.n;
    const before = count();
    const narrow = addAgent(f.db,"artifact-denied-reporter",{...OWNER_AGENT_GRANT, subjects:[PROCEDURE]});
    const narrowCtx = {...f.ctx,principal:authenticate(f.db,narrow.token)!};
    await expect(servePropose(narrowCtx, {...input, object:JSON.stringify({...JSON.parse(input.object),subjectRef:"none"})})).rejects.toThrow();
    await expect(servePropose(who.ctx, {...input, object:JSON.stringify({...JSON.parse(input.object),artifactVersion:{kind:"artifact_binding",digest:outcomeArtifactBinding(artifact.subject)}})})).rejects.toThrow();
    await expect(servePropose(who.ctx, {...input, object:JSON.stringify({...JSON.parse(input.object),artifactVersion:f.findProcedure(who.ctx)})})).rejects.toThrow();
    const pending = servePropose(who.ctx,input);
    revokeSourceGrant(f.db,{source_key:artifact.sourceKey,expected_revision:1,operation_id:"artifact-outcome-preparation"});
    await expect(pending).rejects.toThrow();
    expect(count()).toBe(before);
    // Legacy digest-shaped strings remain quoted reports, never authenticated bindings.
    for (const [index,predicate] of ["outcome.self_report","outcome.observation","outcome.review"].entries())
      await f.file(index,predicate,{artifactVersion:outcomeArtifactBinding(artifact.subject),...(index===2?{result:"accepted"}:{})});
    const bound = f.db.transaction(() => readOutcomes(newReadFrame(f.ctx,worldNamespace(f.db,f.ctx.principal),{kind:"all"}),PROCEDURE,undefined,outcomeArtifactBinding(artifact.subject)))();
    expect(bound.evaluations).toEqual([]);
    expect(bound.goalAchieved).toBe(false);
  } finally { artifacts.dispose(); f.dispose(); }
},120000);
