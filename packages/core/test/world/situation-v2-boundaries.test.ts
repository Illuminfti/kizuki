import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { serveWorldView } from "../../src/serving/world-view";
import { serveCorrect } from "../../src/serving/correct";
import { serveContextPacket } from "../../src/serving/packet";
import { undoReceipt } from "../../src/canon/undo";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { rebuildWorldLayer } from "../../src/derived";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { situationV2Fixture, literal, vocabulary } from "../helpers/situation-v2-fixture";
import { cardFixture } from "./card-fixture";

const node = (f: Awaited<ReturnType<typeof cardFixture>>, id: string) => ({kind:"subject" as const,ref:f.ref(id)});
const dueValues = (f: Awaited<ReturnType<typeof situationV2Fixture>>) => f.readSituation().commitments.find(c=>c.label?.object.kind === "literal" && c.label.object.value === "Review draft")!.due.map(r=>r.object);

test("the writer rejects simultaneous same-perspective cycles, permits disjoint time and distinct holders, and ignores held edges", async()=>{
 const f=await situationV2Fixture(); try {
  await f.declare("project:two","situation","Second");
  await f.write("situation.requires",node(f,"project:two"),{subject:"project:launch",until:"2026-10-22T00:00:00Z"});
  await expect(f.write("situation.blocks",node(f,"project:launch"),{subject:"project:two",from:"2026-10-21T00:00:00Z"})).rejects.toMatchObject({code:"world_cycle"});
  await f.write("situation.blocks",node(f,"project:launch"),{subject:"project:two",from:"2026-10-22T00:00:00Z"});
  expect(f.readSituation().dependencies).toHaveLength(1);
  expect(f.readSituation().coverage.gaps).not.toContain("stale_dependencies");
  await f.write("situation.enables",node(f,"project:launch"),{subject:"project:two",holder:"person:ada"});
  await f.declare("project:held","situation","Third");
  const held=await f.write("situation.requires",node(f,"project:launch"),{subject:"project:held"});
  if(held.stored.outcome!=="stored")throw Error("held edge missing");
  // The same adversarial authority-marked admission used by the serving hold regression.
  f.db.query("UPDATE claim_v2_support SET admission=json_set(admission,'$.rendering.body','owner access') WHERE claim_id=?").run(held.stored.claim.claim_id);
  await f.write("situation.requires",node(f,"project:held"),{subject:"project:launch"});
  expect(f.readSituation().dependencies).toHaveLength(2);
 }finally{f.dispose();}
},120_000);

test("only receipted native-owner completion is done, and undo returns the commitment to open",async()=>{
 const f=await situationV2Fixture();try{
  f.materialize("commitment:review");
  const entry=f.readSituation().commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value==="Review draft")!;
  const answer=await serveCorrect(f.ctx,{statement:"I confirm the review is complete.",target:{world_claim:entry.statusBasis[0]!},mode:"replace_object",object:{kind:"vocabulary",id:"commitment/done"}});
  expect(f.readSituation().commitments.find(c=>c.commitment.token===entry.commitment.token)?.status).toBe("done");
  if(!answer.data||!("receipt_id"in answer.data)||typeof answer.data.receipt_id!=="string")throw Error("receipt missing");
  await undoReceipt({db:f.db,vault_path:f.ctx.vaultPath},answer.data.receipt_id);
  expect(f.readSituation().commitments.find(c=>c.commitment.token===entry.commitment.token)?.status).toBe("open");
 }finally{f.dispose();}
},120_000);

test("nested KNOWN reads exclude Wednesday-learned Monday-valid commitments on Tuesday and preserve old dates after correction",async()=>{
 const f=await situationV2Fixture();try{
  const tuesday="2030-01-08T00:00:00.000Z",wednesday="2030-01-09T00:00:00.000Z";
  f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run(wednesday);
  await f.declare("commitment:late","commitment","Learned Wednesday");
  await f.write("situation.has_commitment",node(f,"commitment:late"),{subject:"project:launch",from:"2030-01-07T00:00:00Z"});
  await f.write("commitment.due",literal("2030-01-12"),{subject:"commitment:late",from:"2030-01-07T00:00:00Z"});
  const past=f.readSituation(f.ctx,{knownAt:{kind:"time",at:tuesday}});
  expect(past.commitments).toHaveLength(2);
  expect(f.readSituation(f.ctx,{knownAt:{kind:"time",at:wednesday}}).commitments).toHaveLength(3);
  f.materialize("commitment:review");
  const before=f.readSituation(f.ctx,{knownAt:{kind:"time",at:wednesday}});
  const old=before.commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value==="Review draft")!;
  await serveCorrect(f.ctx,{statement:"The deadline is now the 25th.",target:{world_claim:old.due[0]!.claim},mode:"replace_object",object:literal("2026-10-25")});
  expect(dueValues(f)).toEqual([literal("2026-10-25")]);
  expect(f.readSituation(f.ctx,{knownAt:before.knownAt}).commitments.find(c=>c.commitment.token===old.commitment.token)?.due).toEqual(old.due);
 }finally{f.dispose();}
},120_000);

test("purge removes nested dates from current and snapshots, rebuild cannot resurrect them, and revoke wins over retained views",async()=>{
 const f=await situationV2Fixture();try{
  const input=f.situationInput(),first=serveWorldView(f.ctx,input).data;
  const historical=f.readSituation(f.ctx,{knownAt:{kind:"time",at:new Date().toISOString()}});
  purgeEvents(f.db,f.ctx.vaultPath,{event_id:f.c2.event.event_id},"synthetic situation deadline erasure");
  expect(dueValues(f)).toEqual([]);
  const old=serveWorldView(f.ctx,{...input,knownAt:historical.knownAt}).data;
  expect(old).toMatchObject({result:{status:"new_view_required"}});
  rebuildWorldLayer(f.db);
  expect(dueValues(f)).toEqual([]);
  revokeSourceGrant(f.db,{source_key:f.sourceKey,expected_revision:1,operation_id:"situation-revoke"});
  expect(serveWorldView(f.ctx,input).data).toMatchObject({status:"not_found"});
  if(!("result"in first)||!("view"in first.result))throw Error("view missing");
  expect(serveWorldView(f.ctx,{...input,priorView:first.result.view}).data).toMatchObject({result:{status:"new_view_required"}});
 }finally{f.dispose();}
},120_000);

test("hidden nested commitments cannot change a narrow reader's bytes or work and object refs remain principal-bound",async()=>{
 const f=await situationV2Fixture();try{
  const agent=addAgent(f.db,"situation-reader",{...OWNER_AGENT_GRANT,ceiling:"public"}),ctx={...f.ctx,principal:authenticate(f.db,agent.token)!};
  const input=f.situationInput(ctx),before=collectReadFrames(()=>serveWorldView(ctx,input));
  if(!("result"in before.result.data)||!("view"in before.result.data.result))throw Error("view missing");
  const request={...input,priorView:before.result.data.result.view};
  const control=collectReadFrames(()=>serveWorldView(ctx,request));
  await f.write("world.kind",vocabulary("world/commitment"),{subject:"commitment:hidden",floor:"private"});
  await f.write("commitment.label",literal("Hidden plan"),{subject:"commitment:hidden",floor:"private"});
  await f.write("situation.has_commitment",node(f,"commitment:hidden"),{subject:"project:launch",floor:"private"});
  const after=collectReadFrames(()=>serveWorldView(ctx,request));
  expect(after.result.data).toEqual(control.result.data);
  expect(after.frames.map(x=>x.stats)).toEqual(control.frames.map(x=>x.stats));
  expect(f.readSituation().commitments).toHaveLength(3);
  expect(serveWorldView(ctx,{...input,situation:f.findSituation()}).data).toMatchObject({status:"not_found"});
 }finally{f.dispose();}
},120_000);

test("session commitments use typed card status and retain separate due perspectives",async()=>{
 const f=await cardFixture(undefined,{purposes:["capture","derive","recall","session","correction","export"]});try{
  for(const[id,kind,label]of [["project:session","situation","Session plan"],["commitment:session","commitment","Send brief"]] as const){
   await f.write("world.kind",vocabulary(`world/${kind}`),{subject:id});await f.write(`${kind}.label`,literal(label!),{subject:id});
  }
  await f.write("situation.has_commitment",node(f,"commitment:session"),{subject:"project:session"});
  await f.write("commitment.due",literal("2026-10-23"),{subject:"commitment:session",holder:"person:ada"});
  await f.write("commitment.status",vocabulary("commitment/done"),{subject:"commitment:session"});
  const packet=await serveContextPacket(f.ctx,{purpose:"session",budget_tokens:2000});
  expect(packet.data?.session?.commitments.served).toBe(1);
  expect(packet.data?.packet_md).toContain("status=claimed_done");
  expect(packet.data?.packet_md).toContain("2026-10-23");
  expect(packet.data?.packet_md).toContain("holder");
 }finally{f.dispose();}
},120_000);
