import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { qualificationCorpus as corpus } from "./corpus-v4";
import { qualificationCorpus as current } from "./corpus";
import { qualificationCorpus as previous } from "./corpus-v3";
import { qualificationCorpus as v2 } from "./corpus-v2";
import { qualificationCorpus as v1 } from "./corpus-v1";
import { candidateRegistry, registryDigest } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { caseInput, scoreCase, scoreRun, validateCorpus, type Observation, type QualificationCase, type Meaning } from "./score";
import type { DraftRef, ExtractResponseV2, TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { withWorldRegistry } from "../../packages/core/src/contracts/world-vocabulary";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { RUNNER_FILES } from "./fingerprint";

const registry = candidateRegistry(WORLD_VOCABULARY_MODULES,
  ["concept", "situation", "question", "person", "skill", "framework", "procedure", "commitment", "decision"], ["situation.has_commitment"]);
const fresh = corpus.cases.filter(item => item.kind === "person");
const promptHash = (item: QualificationCase) => {
  const input = caseInput(item, registry);
  return sha256(withWorldRegistry(registry, () => extractionV2SystemContent(input)));
};

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

test("current corpus replaces only the seven Person cases and retains every other v3 case", () => {
  validateCorpus(corpus);
  expect(current).toBe(corpus);
  expect(corpus.cases).toHaveLength(62);
  expect(fresh).toHaveLength(7);
  expect(corpus.cases.filter(item => item.kind !== "person")).toEqual(previous.cases.filter(item => item.kind !== "person"));
  expect(new Set(fresh.map(item => item.family))).toEqual(new Set(["positive", "perspective", "abstention", "time"]));
  const oldTexts = new Set([v1, v2, previous].flatMap(split => split.cases.flatMap(item => item.records.map(row => row.text))));
  const oldIds = new Set([v1, v2, previous].flatMap(split => split.cases.map(item => item.id)));
  for (const item of fresh) {
    expect(oldIds.has(item.id)).toBe(false);
    for (const row of item.records) expect(oldTexts.has(row.text)).toBe(false);
  }
  expect(scoreRun(corpus, []).kinds.flatMap(row => row.cases).filter(row => row.errors.includes("not_run"))).toHaveLength(62);
});

test("new Person required alternatives and exact optional tuples satisfy the unchanged parser and scorer", () => {
  for (const item of fresh) {
    const base = item.required.map(group => group[0]!);
    const choices = [base, ...item.required.flatMap((group, index) => group.map(row => base.map((value, i) => i === index ? row : value))), ...item.optional.map(row => [...base, row])];
    for (const chosen of choices) expect({ id: item.id, errors: scoreCase(item, control(item, chosen)).errors }).toEqual({ id: item.id, errors: [] });
  }
  const score = scoreRun(corpus, fresh.map(item => control(item)));
  expect(score.kinds.find(row => row.kind === "person")!.status).toBe("passed");
  expect(score.status).toBe("failed");
  expect(score.kinds.flatMap(row => row.cases).filter(row => row.errors.includes("not_run"))).toHaveLength(55);
});

test("one final dependency-closed registry preflights all 62 unchanged-runner requests", () => {
  for (const item of corpus.cases) {
    const input = caseInput(item, registry);
    const plan = withWorldRegistry(registry, () => planModelExtractionV2(input));
    expect({ id: item.id, status: plan.status }).toEqual({ id: item.id, status: "ready" });
  }
  const required = new Set(corpus.cases.flatMap(item => item.required.flat().map(row => row.predicate)));
  const baseline = new Set(JSON.parse(readFileSync(new URL("./preexisting.json", import.meta.url), "utf8")).predicates.map((row: { id: string }) => row.id));
  expect(registry.offered.vocabulary.filter(row => row.predicate !== "world.kind" && !baseline.has(row.predicate) && !required.has(row.predicate)).map(row => row.predicate)).toEqual([]);
});

test("exposure is an optional exact witnessed event, never mastery, role, certain interest or invented time", () => {
  const item = fresh.find(row => row.id === "person-single-reading-exposure-v4")!;
  expect(item.optional).toHaveLength(1);
  expect(item.optional[0]!.predicate).toBe("learning.exposure");
  const required = item.required.map(group => group[0]!), exposure = item.optional[0]!;
  expect(scoreCase(item, control(item, [...required, exposure])).passed).toBe(true);
  for (const predicate of ["learning.explanation", "learning.application", "learning.demonstration", "person.role", "skill.has"]) {
    const row: Meaning = predicate === "person.role" || predicate === "skill.has"
      ? { ...exposure, predicate, object: { kind: "literal", value: "dye diffusion expert" } }
      : { ...exposure, predicate };
    expect(scoreCase(item, control(item, [...required, row])).passed).toBe(false);
  }
  for (const change of [
    { mode: "asserted" as const }, { interpretation: "explicit" as const },
    { valid_from: "2028-02-11T09:00:00Z", temporal_basis: "observed" as const },
  ]) {
    expect(scoreCase(item, control(item, required.map(row => row.predicate === "person.interest" ? { ...row, ...change } : row))).passed).toBe(false);
  }
  expect(scoreCase(item, control(item, [...required, { ...exposure, valid_from: "2028-02-11T09:00:00Z", temporal_basis: "observed" }])).passed).toBe(false);
  expect(scoreCase(item, control(item, [...required, exposure, exposure])).passed).toBe(false);
});

test("asserted source classification does not flatten quoted roles or quoted classifications", () => {
  const item = fresh.find(row => row.id === "person-register-with-disputed-testimony-v4")!;
  const required = item.required.map(group => group[0]!);
  expect(scoreCase(item, control(item)).passed).toBe(true);
  for (const mode of ["reported", "quoted"] as const) {
    expect(scoreCase(item, control(item, required.map(row => row.predicate === "person.role" ? row : { ...row, mode }))).passed).toBe(false);
  }
  for (const change of [{ mode: "asserted" as const }, { holder: null, speaker: null }, { polarity: "positive" as const }]) {
    expect(scoreCase(item, control(item, required.map(row => row.predicate === "person.role" ? { ...row, ...change } : row))).passed).toBe(false);
  }
  const quoted = fresh.find(row => row.id === "person-transcript-attribution-only-v4")!;
  const classification = quoted.optional.find(row => row.predicate === "world.kind")!;
  expect(scoreCase(quoted, control(quoted, [classification])).passed).toBe(true);
  expect(scoreCase(quoted, control(quoted, [{ ...classification, mode: "asserted" }])).passed).toBe(false);
  expect(scoreCase(quoted, control(quoted, [{ ...classification, object: { kind: "vocabulary", value: "world/person" } }])).passed).toBe(false);
});

test("structured identities, exclusive relationship time and injection abstention remain strict", () => {
  const homonyms = fresh.find(row => row.id === "person-independent-roster-homonyms-v4")!;
  const good = control(homonyms);
  expect(scoreCase(homonyms, { ...good, response: { ...good.response!, claims: good.response!.claims.map(row => ({ ...row, subject: { kind: "supplied", id: "ceramics" } })) } }).passed).toBe(false);
  const dated = fresh.find(row => row.id === "person-relationship-exclusive-interval-v4")!;
  expect(scoreCase(dated, control(dated, dated.required.map(group => group[0]!).map(row => row.predicate === "relationship.with" ? { ...row, valid_to: null } : row))).passed).toBe(false);
  const instruction = fresh.find(row => row.id === "person-template-cannot-supply-identity-v4")!;
  expect(scoreCase(instruction, control(instruction)).passed).toBe(true);
  const injected = { ...homonyms.required[0]![0]!, subject: "mention:r1:44:50" };
  expect(scoreCase(instruction, control(instruction, [injected])).passed).toBe(false);
});

test("the original authoring freeze and all case bytes remain unchanged", () => {
  const freeze = JSON.parse(readFileSync(new URL("./corpus-v4-freeze.json", import.meta.url), "utf8"));
  expect(sha256(canonicalJson(corpus))).toBe(freeze.corpus_sha256);
  expect(sha256(readFileSync(new URL("./corpus-v4-person.json", import.meta.url)))).toBe(freeze.person_file_sha256);
  expect(sha256(readFileSync(new URL("./corpus-v3.json", import.meta.url)))).toBe(freeze.retained_v3_file_sha256);
  expect(registryDigest(registry)).toBe(freeze.authoring_registry_sha256);
  expect(freeze.new_person_model_observations_at_freeze).toBe(0);
  expect(freeze.fresh_cases.map(({ id, case_sha256 }: { id: string; case_sha256: string }) => ({ id, case_sha256 })))
    .toEqual(fresh.map(item => ({ id: item.id, case_sha256: sha256(canonicalJson(item)) })));
  for (const path of ["corpus-v4.ts", "corpus-v4-person.json", "corpus-v4-freeze.json"] as const) expect(RUNNER_FILES).toContain(`scripts/world-qualification/${path}`);
});


test("current execution pins bind all 62 cases to the reviewed prompt without rewriting authoring evidence", () => {
  const pins = JSON.parse(readFileSync(new URL("./corpus-v4-execution-pins.json", import.meta.url), "utf8"));
  expect(pins.status).toBe("prepared_not_execution_approved");
  expect(pins.authoring_freeze_sha256).toBe(sha256(readFileSync(new URL("./corpus-v4-freeze.json", import.meta.url))));
  expect(pins.corpus_sha256).toBe(sha256(canonicalJson(corpus)));
  expect(pins.prompt_file_sha256).toBe(sha256(readFileSync(new URL("../../packages/core/src/producer/prompt-v2.ts", import.meta.url))));
  expect(pins.registry_sha256).toBe(registryDigest(registry));
  expect(pins.cases).toEqual(corpus.cases.map(item => ({ id: item.id, case_sha256: sha256(canonicalJson(item)), prompt_sha256: promptHash(item) })));
  expect(RUNNER_FILES).toContain("scripts/world-qualification/corpus-v4-execution-pins.json");
});
