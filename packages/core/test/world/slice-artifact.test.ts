import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import { artifactFixture, ART_WHEN } from "../helpers/artifact-fixture";

test("Artifact slice retains exact version and whole attributed feedback without a model",async()=>{
 const f=await artifactFixture();try{
  const artifact=await f.capture("# Inspection\nThe reviewer says the caption needs more contrast.\n");
  await artifact.feedback("The caption needs more contrast.");
  const card=artifact.card(), input={operation:"slice",task:"Review this exact artifact version",kinds:["artifact_version"],budgetTokens:2000,...ART_WHEN};
  const result=serveWorldView(f.ctx,input).data;
  expect(result).toMatchObject({result:{status:"current",data:{providers:[{kind:"artifact_version",status:"included"}]}}});
  if(!("result"in result)||!("data"in result.result)||result.result.data.schema!=="kizuki.world-slice/v1")throw Error("slice missing");
  const slice=result.result.data;
  expect(slice.constraints.map(item=>item.relation)).toEqual(expect.arrayContaining([card.versionOf,card.inspections[0]]));
  const feedback=slice.constraints.find(item=>item.relation.predicate==="artifact.feedback")!;
  expect(feedback.node).toEqual(artifact.ref());
  expect(feedback.relation.perspective.mode).toBe("quoted");
  expect(feedback.evidence.length).toBeGreaterThan(0);
  expect(slice.coverage.gaps).not.toContain("pending_consolidation");
  expect(packetTokens(JSON.stringify(result))).toBeLessThanOrEqual(2000);
  expect("view"in result.result).toBe(true);
  const retained={...input,priorView:(result.result as {view:unknown}).view};
  expect(serveWorldView(f.ctx,retained).data).toMatchObject({result:{status:"unchanged"}});
  revokeSourceGrant(f.db,{source_key:artifact.sourceKey,expected_revision:1,operation_id:"artifact-slice-revoke"});
  expect(serveWorldView(f.ctx,retained).data).toMatchObject({result:{status:"new_view_required"}});
 }finally{f.dispose();}
},120000);
