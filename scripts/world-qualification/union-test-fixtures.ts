// Scripted evaluator development controls only; never qualification evidence.
import { coreSemanticCaseInput, coreSemanticContract, coreSemanticBranches, coreSemanticBranchRule, type CoreSemanticCase, type GeneralExtractBranch, type LegacyExtractRule } from "./core-semantic";
import { parseExtractResponseV2, type DraftRef, type RichClaimDraft, type ExtractResponseV2, type TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { createWorldUnionCandidateRegistry } from "../../packages/core/src/contracts/world-union-profile";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { DEFAULT_QUALIFICATION_INPUT_POLICY, qualificationInputPlanning, type QualificationInputPolicy } from "./input-planning";
import { modelQuoteAnchorForSpan, resolveModelExtractionWire, MODEL_EXTRACTION_WIRE_SCHEMA } from "../../packages/core/src/producer/model-v2-wire";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { modelWireAdapterIdentity, type CoreSemanticWireEvidence } from "./wire-custody";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import type { ScopedExtractBranch, ScopedPropositionRule } from "./union-propositions";
import type { Observation } from "./score";
import corpus from "./core-semantic-union-corpus.json";
import contract from "./core-semantic-union-contract.json";
const registry = createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES);
type ExtractRule = LegacyExtractRule;
function extractionRule(item: CoreSemanticCase): ExtractRule {
  const rule = coreSemanticContract.cases.find(row => row.case_id === item.id);
  if (rule?.expectation !== "extract") throw new Error("missing authored extraction contract");
  return coreSemanticBranchRule(item.id, coreSemanticBranches(rule)[0]!);
}

function uniqueSpan(item: CoreSemanticCase, quote: string): TextAnchor {
  const index = item.records.findIndex(record => record.text.includes(quote)), record = item.records[index]!;
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous test span");
  return { event_id: String(index + 1).padStart(26, "0"), start_utf16: start, end_utf16: start + quote.length };
}

function scriptedLegacy(item: CoreSemanticCase, policy: QualificationInputPolicy = DEFAULT_QUALIFICATION_INPUT_POLICY): Observation {
  const input = coreSemanticCaseInput(item, registry, policy), authored = coreSemanticContract.cases.find(row => row.case_id === item.id)!, rule = authored.expectation === "abstain" ? authored : extractionRule(item);
  if (rule.expectation === "abstain") return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions: [], claims: [] }, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 10 } };
  const targetAnchor = uniqueSpan(item, rule.target.quote), target: DraftRef = { kind: "mention", id: "m-target" };
  const mentionSources = new Map<string, { ref: DraftRef; anchor: TextAnchor; attributionAnchor: TextAnchor; label: string }>();
  for (const contract of [rule.classification, ...(rule.label_rule ? [rule.label_rule] : []), ...rule.details]) if (contract.source !== undefined && typeof contract.source !== "string") {
    const key = canonicalJson(contract.source), anchor = uniqueSpan(item, contract.source.quote);
    if (!mentionSources.has(key)) mentionSources.set(key, { ref: { kind: "mention", id: `m-source-${mentionSources.size + 1}` }, anchor,
      attributionAnchor: uniqueSpan(item, contract.source.attribution_witness), label: contract.source.label });
  }
  const proposition = (id: string, predicate: string, object: RichClaimDraft["object"], contract: NonNullable<ExtractRule["label_alternatives"]>[number], body: string): RichClaimDraft => {
    const source = contract.source === undefined ? null : typeof contract.source === "string" ? ({ kind: "supplied", id: contract.source } as const) : mentionSources.get(canonicalJson(contract.source))!.ref;
    const perspective = contract.perspective === "direct"
      ? { holder: null, speaker: null, addressee: null, mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] }
      : contract.perspective === "person_statement"
        ? { holder: null, speaker: source, addressee: null, mode: "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] }
        : { holder: source, speaker: null, addressee: null, mode: contract.perspective === "document_suggestion" ? "suggested" as const : "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] };
    const time = contract.time === "unknown" ? { valid_from: null, valid_to: null, temporal_basis: "unknown" as const }
      : { valid_from: contract.time.valid_from, valid_to: contract.time.valid_to, temporal_basis: contract.time.temporal_basis };
    const witness = uniqueSpan(item, contract.witness), timeWitness = contract.time === "unknown" ? null : uniqueSpan(item, contract.time.witness);
    const roleWitness = contract.attribution_witness ?? (typeof contract.source === "object" ? contract.source.attribution_witness : undefined);
    const anchors = [targetAnchor, witness, ...(timeWitness === null ? [] : [timeWitness]), ...(roleWitness === undefined ? [] : [uniqueSpan(item, roleWitness)])];
    return { id, subject: target, predicate, object, perspective, context: [], polarity: "positive", body, ...time, confidence: 0.8, sensitivity: "personal",
      anchors: [...new Map(anchors.map(anchor => [canonicalJson(anchor), anchor])).values()] };
  };
  const claims: RichClaimDraft[] = [
    proposition("c1", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: rule.classification.kind } }, rule.classification, `${rule.classification.label} is classified as ${rule.classification.kind}.`),
    proposition("c2", `${item.kind}.label`, { kind: "literal", value: rule.classification.label }, rule.label_rule ?? rule.label_alternatives?.[0] ?? rule.classification, `The source names it ${rule.classification.label}.`),
    ...rule.details.map((detail, index) => { const literal = detail.witness; return proposition(`c${index + 3}`, detail.predicate, { kind: "literal", value: literal }, detail, literal); }),
  ];
  const mentions = [{ id: "m-target", label: rule.target.quote, anchor: targetAnchor, candidate_refs: [] },
    ...[...mentionSources.values()].map(source => ({ id: source.ref.id, label: source.label, anchor: source.anchor, candidate_refs: [] }))];
  return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions, claims } as ExtractResponseV2, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 100 } };
}

function general(item: CoreSemanticCase, branch: GeneralExtractBranch | ScopedExtractBranch, policy: QualificationInputPolicy): Observation {
  const input = coreSemanticCaseInput(item, registry, policy);
  const anchor = (record: string, quote: string, repeated = false): TextAnchor => {
    const index = item.records.findIndex(r => r.id === record), text = item.records[index]!.text, start = text.indexOf(quote);
    if (start < 0 || (!repeated && text.indexOf(quote, start + 1) >= 0)) throw Error("ambiguous scripted witness");
    return { event_id: input.events[index]!.event_id, start_utf16: start, end_utf16: start + quote.length };
  };
  const mentions = branch.entities.map((e, index) => ({ id: `m${index}`, label: e.label, anchor: anchor(e.record, e.label, true), candidate_refs: [] }));
  const ref = (s: ScopedPropositionRule["subject"]): DraftRef => {
    if (s.mode === "source_occurrence") return { kind: "mention", id: mentions.find(m => m.label === s.label && m.anchor.event_id === input.events[item.records.findIndex(r => r.id === s.record)]!.event_id)!.id };
    const record = item.records.find(r => r.id === s.record)!, name = record.structured_subjects!.find(v => v.subject_id === s.subject_id)!.display_name!;
    const a = anchor(s.record, name), supplied = input.supplied_refs.find(v => v.anchors.some(v => canonicalJson(v) === canonicalJson(a)));
    if (!supplied) throw Error("scripted genuine handle unavailable");
    return { kind: "supplied", id: supplied.id };
  };
  const anchors = (r: DraftRef): readonly TextAnchor[] => r.kind === "mention" ? [mentions.find(m => m.id === r.id)!.anchor] : input.supplied_refs.find(s => s.id === r.id)!.anchors;
  const unique = (a: readonly TextAnchor[]) => [...new Map(a.map(v => [canonicalJson(v),v])).values()];
  const claims: RichClaimDraft[] = branch.propositions.map((p: ScopedPropositionRule,index) => {
    const subject = ref(p.subject), source = item.records.find(r => r.id === p.subject.record)!.text;
    const label = p.subject.mode === "source_occurrence" ? p.subject.label : item.records.find(r => r.id === p.subject.record)!.structured_subjects!.find(s => s.subject_id === (p.subject as {subject_id:string}).subject_id)!.display_name!;
    const literal = p.object.kind !== "literal" ? "" : p.witness_mode ? label : source.includes(p.object.required_atoms[0]!) ? p.object.required_atoms[0]! : p.witness;
    const object: RichClaimDraft["object"] = p.object.kind === "subject" ? {kind:"subject",ref:ref(p.object.entity)} : p.object.kind === "vocabulary" ? {kind:"vocabulary",ref:{kind:"vocabulary",id:p.object.value}} : {kind:"literal",value:literal};
    const holder = p.perspective.holder && ref(p.perspective.holder), speaker = p.perspective.speaker && ref(p.perspective.speaker), addressee = p.perspective.addressee && ref(p.perspective.addressee);
    const context = p.context.map(ref);
    return {id:`c${index}`,subject,predicate:p.predicate,object,perspective:{...p.perspective,holder,speaker,addressee,anchors:unique([holder,speaker,addressee].flatMap(r=>r?anchors(r):[]))},context,polarity:p.polarity,
      valid_from:p.time.valid_from,valid_to:p.time.valid_to,temporal_basis:p.time.temporal_basis,
      body:p.required_relation_atoms?.join(" ")??(p.object.kind==="literal"?literal:p.witness),confidence:0.5,sensitivity:"personal",
      anchors:unique([...(p.witness_mode?[]:[anchor(p.subject.record,p.witness)]),...anchors(subject),...(object.kind==="subject"?anchors(object.ref):[]),...context.flatMap(anchors),
        ...(p.time.witness?[anchor(p.subject.record,p.time.witness)]:[]),...(p.attribution_witness?[anchor(p.subject.record,p.attribution_witness)]:[])])};
  });
  return {case_id:item.id,input,status:"ok",response:{schema:"kizuki.producer-response/v2",mentions,claims},dropped:0,usage:{calls:1,input_tokens:100,output_tokens:100}};
}
export function scriptedUnionObservations(policy: QualificationInputPolicy): Observation[] {
  return corpus.cases.map((raw,index) => {
    const item = raw as CoreSemanticCase, rule = contract.cases[index]!;
    let row: Observation;
    if (index < 13) row = scriptedLegacy(item,policy);
    else if (rule.expectation === "abstain") row = {case_id:item.id,input:coreSemanticCaseInput(item,registry,policy),status:"ok",response:{schema:"kizuki.producer-response/v2",mentions:[],claims:[]},dropped:0,usage:{calls:1,input_tokens:100,output_tokens:100}};
    else row = general(item,(rule as unknown as {branches:(GeneralExtractBranch|ScopedExtractBranch)[]}).branches[0]!,policy);
    const {budget:_,...input}=row.input,parsed=parseExtractResponseV2(JSON.stringify(row.response),input);
    if(!parsed.ok||parsed.dropped.length)throw Error(`scripted response rejected:${item.id}`);
    return {...row,response:parsed.response};
  });
}
export function scriptedWire(row: Observation, policy: QualificationInputPolicy) {
  if(!row.response)throw Error("scripted response missing");
  const plan=planModelExtractionV2(row.input,policy.input_token_overhead);
  if(plan.status!=="ready")throw Error("scripted planning refused");
  const descriptor=(a:TextAnchor)=>{
    const d=modelQuoteAnchorForSpan(a,plan.outbound.events);if(!d)throw Error("scripted descriptor unavailable");
    if(!d.select)return d;
    const text=plan.outbound.events.find(e=>e.event_id===a.event_id)!.text;
    for(let extra=1;extra<=80;extra++)for(let left=0;left<=extra;left++){
      const start=a.start_utf16-left,end=a.end_utf16+extra-left;if(start<0||end>text.length)continue;
      const quote=text.slice(start,end);
      if(text.indexOf(quote)===start&&text.indexOf(quote,start+1)<0&&quote.indexOf(d.select)===left&&quote.indexOf(d.select,left+1)<0)return{event_id:a.event_id,quote,select:d.select};
    }
    return d;
  };
  const rawText=JSON.stringify({...row.response,schema:MODEL_EXTRACTION_WIRE_SCHEMA,mentions:row.response.mentions.map(m=>({...m,anchor:descriptor(m.anchor)})),
    claims:row.response.claims.map(c=>({...c,anchors:c.anchors.map(descriptor),perspective:{...c.perspective,anchors:c.perspective.anchors.map(descriptor)}}))});
  const resolved=resolveModelExtractionWire(rawText,plan.outbound);if(!resolved.ok||canonicalJson(JSON.parse(resolved.text))!==canonicalJson(row.response))throw Error("scripted wire mismatch");
  const adapter=modelWireAdapterIdentity();
  const evidence:CoreSemanticWireEvidence={case_id:row.case_id,producer_input_token_overhead:policy.input_token_overhead,input_planning:qualificationInputPlanning(row.input,policy),transport_response_sha256:"b".repeat(64),
    adapter_source_sha256:adapter.source_sha256,resolution_receipt_sha256:sha256(canonicalJson(resolved.receipt)),receipt:resolved.receipt};
  return {rawText,evidence};
}
