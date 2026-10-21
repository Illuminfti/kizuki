import { expect, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { servePropose } from "../../src/serving/propose";
import { serveContextPacket } from "../../src/serving/packet";
import { readSituations } from "../../src/world/situations";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { rebuildWorldLayer } from "../../src/derived";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { enrollSource } from "../helpers/world-seed";
import { situationV2Fixture, literal, vocabulary } from "../helpers/situation-v2-fixture";

async function fixture() {
  const purposes = ["capture","derive","recall","correction","export","session"] as const;
  const f = await situationV2Fixture(undefined,{purposes});
  await f.write("commitment.deliverable",literal("required fields reviewed"),{subject:"commitment:review"});
  await f.write("commitment.status",vocabulary("commitment/done"),{subject:"commitment:review"});
  const actors = ["reporter","observer","reviewer"].map(name => {
    const agent=addAgent(f.db,name,OWNER_AGENT_GRANT), connector=`situation.${name}`;
    return {ctx:{...f.ctx,principal:authenticate(f.db,agent.token)!},connector,source:enrollSource(f.db,connector,"public",undefined,undefined,purposes)};
  });
  const entry=(ctx=f.ctx,when:Record<string,unknown>={})=>f.readSituation(ctx,when).commitments.find(c=>c.label?.object.kind==="literal"&&c.label.object.value==="Review draft")!;
  const conditions={task:"review",attempt:"attempt-1",criterion:"required fields reviewed",artifactVersion:"draft-1",environment:"synthetic-review",assistance:"assisted",confounded:false};
  const file=async(index:number,predicate:string,result:string,patch:Record<string,unknown>={})=>{
    const actor=actors[index]!;
    const capture=accept(f.db,{...validEvent(),connector_id:actor.connector,source_record_id:ulid(),text:`${actor.connector} ${predicate} ${result} ${ulid()}`,
      sensitivity_hint:"public",subjects:[{subject_id:"commitment:review",role:"about"}]},{source:{source_key:actor.source,expected_revision:1}});
    if(capture.status!=="stored")throw Error("outcome capture failed");
    const answer=await servePropose(actor.ctx,{kind:"claim",subject:"commitment:review",subjects:["commitment:review"],predicate,
      object:JSON.stringify({...conditions,subjectRef:entry(actor.ctx).commitment.token,result,...patch}),body:`Attributed ${predicate}`,
      provenance:[capture.event.event_id],confidence:0.8});
    expect(answer.data?.outcome).toBe("stored");
    return capture.event.event_id;
  };
  return {...f,entry,file,actors};
}

test("independent completion requires exact deliverable criterion and distinct report, observation and review roots",async()=>{
 const f=await fixture();try{
  expect(f.entry().status).toBe("claimed_done");
  await f.file(0,"outcome.self_report","met");
  await f.file(0,"outcome.provider_ack","acknowledged");
  await f.file(1,"outcome.observation","met",{criterion:"unrelated criterion"});
  await f.file(2,"outcome.review","accepted",{criterion:"unrelated criterion"});
  expect(f.entry().status).toBe("claimed_done");
  const observed=await f.file(1,"outcome.observation","met");
  expect(f.entry().status).toBe("claimed_done");
  await f.file(2,"outcome.review","accepted");
  expect(f.entry().status).toBe("done");
  expect(f.entry().statusBasis.length).toBeGreaterThanOrEqual(3);
  purgeEvents(f.db,f.ctx.vaultPath,{event_id:observed},"erase synthetic observation");
  expect(f.entry().status).toBe("claimed_done");
  rebuildWorldLayer(f.db);
  expect(f.entry().status).toBe("claimed_done");
 }finally{f.dispose();}
},120_000);

test("session current completion agrees with the card while past-valid and retained-history reads never borrow it",async()=>{
 const f=await fixture();try{
  const past=f.readSituation(f.ctx,{knownAt:{kind:"time",at:new Date().toISOString()}});
  await f.file(0,"outcome.self_report","met");
  await f.file(1,"outcome.observation","met");
  await f.file(2,"outcome.review","accepted");
  expect(f.entry().status).toBe("done");
  const packet=await serveContextPacket(f.ctx,{purpose:"session",budget_tokens:2000});
  expect(packet.data?.session?.commitments.served).toBe(1);
  expect(packet.data?.packet_md).not.toContain("Review draft; status=claimed_done");
  const validPast=f.entry(f.ctx,{valid:{kind:"at",at:"2026-10-20T00:00:00Z"}});
  expect(validPast.status).toBe("claimed_done");
  expect(f.entry(f.ctx,{knownAt:past.knownAt}).status).toBe("claimed_done");
  const explicitPast=readSituations(f.ctx,{limit:8,at:"2026-10-20T00:00:00Z",canRead:()=>true});
  expect(explicitPast.flatMap(s=>s.commitments).some(c=>c.text.includes("Review draft; status=claimed_done"))).toBe(true);
  revokeSourceGrant(f.db,{source_key:f.actors[1]!.source,expected_revision:1,operation_id:"revoke-observer"});
  expect(f.entry().status).toBe("claimed_done");
 }finally{f.dispose();}
},120_000);

import type { Database } from "bun:sqlite";
import { dispatchServeTool } from "../../src/serving/dispatch";

test("an omitted completed commitment retains its evidence at final packet publication",async()=>{
 const f=await fixture();try{
  // Keep one commitment and no other Situation lines that could accidentally
  // carry its dependency closure through a displayed sibling.
  f.db.exec(`UPDATE claims SET status='reverted' WHERE claim_id IN
    (SELECT claim_id FROM claim_v2_semantics WHERE
      (predicate='situation.has_commitment' AND json_extract(payload,'$.object.ref.id')='commitment:notes') OR
      predicate='situation.has_decision' OR
      (predicate='commitment.status' AND json_extract(payload,'$.object.ref.id')='commitment/open'))`);
  await f.file(0,"outcome.self_report","met");
  await f.file(1,"outcome.observation","met");
  await f.file(2,"outcome.review","accepted");
  expect(f.entry().status).toBe("done");
  let changed=false;
  const db=new Proxy(f.db,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==="transaction")return(run:()=>unknown)=>{
      const tx=target.transaction(run),finish=(result:unknown)=>{
        if(!changed&&!target.inTransaction&&Array.isArray(result)&&result.some(row=>row&&typeof row==="object"&&"world" in row&&"commitments" in row)){
          changed=true;
          expect(result.flatMap(row=>row.commitments)).toHaveLength(0);
          target.exec("UPDATE claims SET status='reverted' WHERE predicate='outcome.observation'");
        }
        return result;
      };
      return Object.assign(()=>finish(tx()),{immediate:()=>finish(tx.immediate())});
    };
    return typeof value==="function"?value.bind(target):value;
  }}) as Database;
  await expect(dispatchServeTool({...f.ctx,db},"context_packet",{purpose:"session",budget_tokens:2000},{response_contract:"kizuki.envelope/v2"}))
    .rejects.toThrow("authorized evidence changed during request");
  expect(changed).toBe(true);
 }finally{f.dispose();}
},120_000);
