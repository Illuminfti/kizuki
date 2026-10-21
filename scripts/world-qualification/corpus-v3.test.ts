import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { qualificationCorpus as corpus } from './corpus-v3';
import { qualificationCorpus as previous } from './corpus-v2';
import { candidateRegistry } from './registry';
import { WORLD_VOCABULARY_MODULES } from './candidate-modules';
import { caseInput, scoreCase, scoreRun, validateCorpus, type Observation, type QualificationCase, type Meaning } from './score';
import type { DraftRef, ExtractResponseV2, TextAnchor } from '../../packages/core/src/contracts/producer-v2';
import { canonicalJson, sha256 } from '../evaluate-extraction';
import { WORLD_REGISTRY, withWorldRegistry } from '../../packages/core/src/contracts/world-vocabulary';
import { planModelExtractionV2 } from '../../packages/core/src/producer/model-v2';

const registry = candidateRegistry(WORLD_VOCABULARY_MODULES,
  ['concept','situation','question','person','skill','framework','procedure','commitment','decision'], ['situation.has_commitment']);

/** Authored oracle satisfiability only; never provider provenance or actual model quality. */
function control(item: QualificationCase, chosen: Meaning[] = item.required.map(group => group[0]!), candidate = registry): Observation {
  const input = caseInput(item, candidate), mentions: ExtractResponseV2['mentions'][number][] = [];
  const seen = new Map<string, DraftRef>();
  const ref = (value: string | null): DraftRef | null => {
    if (value === null) return null;
    value = item.references?.find(group => group.key === value)?.refs[0] ?? value;
    if (value.startsWith('supplied:')) return { kind:'supplied',id:value.slice(9) };
    const prior = seen.get(value); if (prior) return prior;
    const [,recordId,start,end] = value.split(':'), event = input.events[item.records.findIndex(record => record.id === recordId)]!;
    const id=`m${mentions.length+1}`, nomination=item.nominations?.find(row=>row.mention===value)?.supplied;
    const anchor={event_id:event.event_id,start_utf16:Number(start),end_utf16:Number(end)};
    mentions.push({id,label:event.text.slice(anchor.start_utf16,anchor.end_utf16),anchor,candidate_refs:nomination===undefined?[]:[{kind:'supplied',id:nomination}]});
    const result={kind:'mention' as const,id};seen.set(value,result);return result;
  };
  const anchors = (refs:(DraftRef|null)[], citations:string[]):TextAnchor[] => {
    const result=citations.map(id=>{const event=input.events[item.records.findIndex(row=>row.id===id)]!;return {event_id:event.event_id,start_utf16:0,end_utf16:event.text.length};});
    const cited=new Set(result.map(a=>a.event_id));
    for(const r of refs)if(r!==null)result.push(...(r.kind==='supplied'?input.supplied_refs.find(x=>x.id===r.id)!.anchors.filter(a=>cited.has(a.event_id)):[mentions.find(m=>m.id===r.id)!.anchor]));
    return [...new Map(result.map(a=>[canonicalJson(a),a])).values()];
  };
  const claims=chosen.map((row,index)=>{
    const subject=ref(row.subject)!,context=row.context.map(value=>ref(value)!);
    const object=row.object.kind==='literal'?{kind:'literal' as const,value:row.object.value}:row.object.kind==='vocabulary'?{kind:'vocabulary' as const,ref:{kind:'vocabulary' as const,id:row.object.value}}:{kind:'subject' as const,ref:ref(row.object.value)!};
    const holder=ref(row.holder),speaker=ref(row.speaker),addressee=ref(row.addressee);
    return {id:`c${index+1}`,subject,predicate:row.predicate,object,perspective:{holder,speaker,addressee,mode:row.mode,interpretation:row.interpretation,anchors:anchors([holder,speaker,addressee],row.perspective_citations)},context,polarity:row.polarity,body:'Synthetic oracle satisfiability control.',valid_from:row.valid_from,valid_to:row.valid_to,temporal_basis:row.temporal_basis,confidence:0.5,sensitivity:'personal' as const,anchors:anchors([subject,...(object.kind==='subject'?[object.ref]:[]),...context],row.citations)};
  });
  return {case_id:item.id,input,status:'ok',response:{schema:'kizuki.producer-response/v2',mentions,claims},dropped:0,usage:{calls:1,input_tokens:10,output_tokens:10}};
}

test('fresh full split retains every family and boundary group without copying prior source records',()=>{
  validateCorpus(corpus);
  expect(corpus.cases).toHaveLength(62);
  const counts=Object.fromEntries([...new Set(corpus.cases.map(c=>c.kind))].map(kind=>[kind,corpus.cases.filter(c=>c.kind===kind).length]));
  expect(counts).toEqual({concept:10,situation:6,question:6,person:7,skill:6,framework:6,procedure:7,commitment:8,decision:6});
  const old=new Set(previous.cases.flatMap(c=>c.records.map(r=>r.text)));
  expect(corpus.cases.flatMap(c=>c.records).some(r=>old.has(r.text))).toBe(false);
  expect(scoreRun(corpus,[]).status).toBe('not_run');
  const tested=new Set(corpus.cases.flatMap(c=>c.required.flat().map(m=>m.predicate)));
  const baseline=new Set(WORLD_REGISTRY.offered.vocabulary.map(p=>p.predicate));
  expect(registry.offered.vocabulary.filter(p=>!baseline.has(p.predicate)&&!tested.has(p.predicate)).map(p=>p.predicate)).toEqual([]);
});

test('every declared required alternative and optional tuple is typed, bounded, and satisfiable before observations',()=>{
  for(const item of corpus.cases){
    const base=item.required.map(g=>g[0]!);
    const alternatives=[base,...item.required.flatMap((group,index)=>group.map(m=>base.map((v,i)=>i===index?m:v))),...item.optional.map(m=>[...base,m])];
    for(const chosen of alternatives)expect({id:item.id,errors:scoreCase(item,control(item,chosen)).errors}).toEqual({id:item.id,errors:[]});
    const input=caseInput(item,registry);
    const plan=withWorldRegistry(registry,()=>planModelExtractionV2(input));
    expect({id:item.id,status:plan.status}).toEqual({id:item.id,status:'ready'});
  }
});

test('the 17-case first tranche contains whole Concept and Person groups and leaves 45 not_run',()=>{
  const selected=corpus.cases.filter(c=>['concept','person'].includes(c.kind));
  expect(selected).toHaveLength(17);
  const candidate=candidateRegistry(WORLD_VOCABULARY_MODULES,['concept','person']);
  expect(candidate.kinds.filter(k=>k.offeredToProducer).map(k=>k.id).sort()).toEqual(['concept','person','situation']);
  const score=scoreRun(corpus,selected.map(c=>control(c,undefined,candidate)));
  expect(score.status).toBe('failed');
  expect(score.kinds.filter(k=>k.status==='passed').map(k=>k.kind)).toEqual(['concept','person']);
  expect(score.kinds.flatMap(k=>k.cases).filter(c=>c.errors.includes('not_run'))).toHaveLength(45);
});

test('interest promotion, quotation flattening, invented time and missing identity witness grounding fail',()=>{
  const interest=corpus.cases.find(c=>c.id==='person-isolated-attention-hypothesis-v3')!;
  const good=control(interest), index=good.response!.claims.findIndex(c=>c.predicate==='person.interest');
  const claim=good.response!.claims[index]!;
  for(const replacement of [
    {...claim,perspective:{...claim.perspective,mode:'asserted' as const}},
    {...claim,perspective:{...claim.perspective,interpretation:'explicit' as const}},
    {...claim,predicate:'person.role',object:{kind:'literal' as const,value:'typography expert'}},
    {...claim,valid_from:'2027-01-01T00:00:00Z',temporal_basis:'explicit' as const},
  ])expect(scoreCase(interest,{...good,response:{...good.response!,claims:good.response!.claims.map((c,i)=>i===index?replacement:c)}}).passed).toBe(false);
  const quoted=corpus.cases.find(c=>c.id==='person-opposed-speakers-v3')!, attributed=control(quoted);
  expect(scoreCase(quoted,{...attributed,response:{...attributed.response!,claims:attributed.response!.claims.map(c=>({...c,perspective:{...c.perspective,mode:'asserted'}}))}}).passed).toBe(false);
  const identity=corpus.cases.find(c=>c.id==='concept-identity-independent-witness-v3')!, linked=control(identity);
  expect(scoreCase(identity,{...linked,response:{...linked.response!,mentions:linked.response!.mentions.map(m=>({...m,candidate_refs:[]}))}}).errors).toContain('incorrect_nomination');
});

test('oracle bytes are pinned before any model observation',()=>{
  const freeze=JSON.parse(readFileSync(new URL('./corpus-v3-freeze.json',import.meta.url),'utf8'));
  expect(sha256(canonicalJson(corpus))).toBe(freeze.corpus_sha256);
  expect(sha256(readFileSync(new URL('./corpus-v3.json',import.meta.url)))).toBe(freeze.corpus_file_sha256);
  expect(freeze.model_observations_at_freeze).toBe(0);
});
