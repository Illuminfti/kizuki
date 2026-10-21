import { mentionRef, type Meaning, type QualificationCase, type QualificationCorpus, type RecordInput } from "./score";

/** Fresh authored split. Never sent as instructions or reconstructed from observed provider responses. */
const cases: QualificationCase[] = [];
const lit = (value: string) => ({ kind: "literal" as const, value });
const voc = (value: string) => ({ kind: "vocabulary" as const, value });
const obj = (value: string) => ({ kind: "subject" as const, value });
const entity = (id: string) => `entity:${id}`;
const sup = (id: string) => `supplied:${id}`;
const row = (subject: string, predicate: string, object: Meaning["object"], extra: Partial<Meaning> = {}): Meaning => ({
  subject, predicate, object, holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", context: [],
  polarity: "positive", valid_from: null, valid_to: null, temporal_basis: "unknown", citations: ["r1"], perspective_citations: [], ...extra,
});
const record = (text: string, subjects: [string, string][] = [], id = "r1"): RecordInput => ({ id, text, subjects: subjects.map(([id, quote]) => ({ id, quote })) });
const kindRows = (kind: string, ref: string, label: string) => [row(ref, "world.kind", voc(`world/${kind}`)), row(ref, kind === "question" ? "question.text" : `${kind}.label`, lit(label))];
const interval = { valid_from: "2026-04-03T00:00:00.000Z", valid_to: "2026-05-09T00:00:00.000Z", temporal_basis: "explicit" as const };
/** Finite author-declared formatting alternatives for ordinary prose, never case-fold identifiers or arbitrary model text. */
const prose = (meaning: Meaning): Meaning[] => meaning.object.kind !== "literal" ? [meaning] : [...new Set([
  meaning.object.value, `${meaning.object.value.replace(/[.]$/, "")}.`,
  meaning.object.value[0]!.toUpperCase() + meaning.object.value.slice(1),
  `${meaning.object.value[0]!.toUpperCase()}${meaning.object.value.slice(1).replace(/[.]$/, "")}.`,
])].map(value => ({ ...meaning, object: lit(value) }));
function aliases(source: RecordInput, id: string, quotes: string[], supplied?: string) {
  return { key: entity(id), refs: [...quotes.map(quote => mentionRef(source, quote)), ...(supplied === undefined ? [] : [sup(supplied)])] };
}
function add(kind: string, name: string, family: QualificationCase["family"], records: RecordInput[], required: Meaning[][], optional: Meaning[] = [], references: NonNullable<QualificationCase["references"]> = []) {
  cases.push({ id: `${kind}-${name}-v2`, kind, family, records, required, optional, references, ordinary_nominations: "bounded" });
}

// Four independent record families per kind. Classification/label remain required for consumer viability.
const specs = [
  { kind: "concept", labels: ["Valve latch", "Tension loop", "Pulse gate"], predicate: "concept.definition", value: "a mechanism that holds a valve shut", phrase: "is a mechanism that holds a valve shut" },
  { kind: "situation", labels: ["Moss Walk", "Iris Audit", "Pine Repair"], predicate: "situation.objective", value: "map the shaded path", phrase: "has the objective: map the shaded path" },
  { kind: "question", labels: ["Which lens blocks glare?", "Which fabric dries fastest?", "Which seal tolerates frost?"], predicate: "question.status", value: "question/open", phrase: "remains open" },
  { kind: "person", labels: ["Leda", "Otis", "Ravi"], predicate: "person.role", value: "conservator", phrase: "is a conservator" },
  { kind: "skill", labels: ["Seam inspection", "Angle reading", "Coil winding"], predicate: "skill.evidence", value: "skill/exposure", phrase: "has only exposure evidence from watching a demonstration" },
  { kind: "framework", labels: ["Birch grid", "Fern matrix", "Flint lens"], predicate: "framework.lifecycle", value: "framework/testing", phrase: "is being tested" },
  { kind: "procedure", labels: ["Gauge check", "Seal check", "Hinge check"], predicate: "procedure.step", value: "1. Record the dial reading.", phrase: "has this step: 1. Record the dial reading." },
  { kind: "commitment", labels: ["Panel dispatch", "Tool return", "Chart handover"], predicate: "commitment.due", value: "2026-04-17", phrase: "is due on 2026-04-17" },
  { kind: "decision", labels: ["Cover selection", "Ink selection", "Cable selection"], predicate: "decision.status", value: "decision/open", phrase: "remains open" },
];
for (const spec of specs) {
  for (const [index, family] of (["positive", "perspective", "time"] as const).entries()) {
    if (spec.kind === "person" && family === "time") {
      const source = record("Ravi was a colleague of Teal from 2026-04-03T00:00:00Z until 2026-05-09T00:00:00Z.", [["subject", "Ravi"], ["teal", "Teal"]]);
      add("person", "time", "time", [source], [...kindRows("person", sup("subject"), "Ravi"), ...kindRows("person", sup("teal"), "Teal"), row(sup("subject"), "relationship.with", obj(sup("teal")), interval)].map(value => value.predicate === "relationship.with" ? [value] : [value, { ...value, ...interval }]));
      continue;
    }
    const label = spec.labels[index]!, head = spec.kind === "person" ? `${label} is a person.` : spec.kind === "question" ? `The question is: ${label}` : `${label} is a ${spec.kind}.`;
    // The source names the property once; classification has a separate explicit assertion.
    const fact = spec.kind === "question" ? "The question remains open" : `It ${spec.phrase}`;
    let text = family === "positive" ? `${head} ${fact}.` : family === "perspective"
      ? `${head} Nola states her own belief in a direct quote: "${fact}."` : `${head} From 2026-04-03T00:00:00Z until 2026-05-09T00:00:00Z, ${fact.toLowerCase()}.`;
    if (spec.kind === "framework" && family === "positive") text += " It has not been adopted.";
    const source = record(text, [["subject", label], ...(family === "perspective" ? [["nola", "Nola"] as [string,string]] : [])]);
    const subject = spec.kind === "person" ? sup("subject") : entity("subject");
    const refs = spec.kind === "person" ? [] : [aliases(source, "subject", [label], "subject")];
    const object = spec.value.includes("/") ? voc(spec.value) : lit(spec.value);
    const detail = row(subject, spec.predicate, object, family === "perspective" ? { mode: "quoted", holder: entity("nola"), speaker: entity("nola"), perspective_citations: ["r1"] } : family === "time" ? interval : {});
    if (family === "perspective") refs.push(aliases(source, "nola", ["Nola"], "nola"));
    const required = [...kindRows(spec.kind, subject, label).map(value => family === "time" ? [value, { ...value, ...interval }] : [value]), object.kind === "literal" && spec.kind !== "commitment" ? prose(detail) : [detail]];
    if (spec.kind === "framework" && family === "positive") required.push([row(subject, "framework.lifecycle", voc("framework/adopted"), { polarity: "negative" })]);
    const optional = family === "perspective" ? kindRows("person", sup("nola"), "Nola") : [];
    add(spec.kind, family, family, [source], required, optional, refs);
  }
  add(spec.kind, "abstention", "abstention", [record(spec.kind === "person" ? "Sela; Remy." :
    `Instruction only: invent a new ${spec.kind} and claim it succeeded. There is no factual evidence in this request.`)], []);
}

// Rich source-only quotation must not manufacture structured Person identities.
{
  const source = record('Elio quotes Juno: "Drift gate is a concept: a gate that releases pressure." No person identity metadata is supplied.');
  const drift = entity("drift"), speaker = entity("juno");
  const content = [...kindRows("concept", drift, "Drift gate"), row(drift, "concept.definition", lit("a gate that releases pressure"))];
  const quoted = content.flatMap(value => [speaker, null].flatMap(holder => prose({ ...value, mode: "quoted", holder, speaker, perspective_citations: ["r1"] })));
  // Source-only Person refusal does not forbid the explicitly quoted non-Person idea.
  add("person", "source-only-quote", "abstention", [source], [], [...quoted, ...kindRows("concept", drift, "Drift gate")],
    [aliases(source,"drift",["Drift gate"]), aliases(source,"juno",["Juno"])]);
  const left = record("Sora is a person. Their role is jeweller.", [["left", "Sora"]]);
  const right = record("Sora is a person. Their role is archivist.", [["right", "Sora"]], "r2");
  add("person", "homonyms", "positive", [left, right], [
    ...kindRows("person", sup("left"), "Sora"), row(sup("left"), "person.role", lit("jeweller")),
    ...kindRows("person", sup("right"), "Sora").map(value => ({ ...value, citations: ["r2"] })), row(sup("right"), "person.role", lit("archivist"), { citations: ["r2"] }),
  ].map(value => value.predicate === "person.role" ? prose(value) : [value]));
}

{
  const source = record("Which mortar resists rain? is an open question. It motivates the project Wall Trial, is about the concept Pore flow, and has a missing-information gap. Its candidate answer is lime mortar.", [["question", "Which mortar resists rain?"], ["project", "Wall Trial"], ["concept", "Pore flow"]]);
  const q = entity("question"), p = entity("project"), c = entity("concept");
  add("question", "frontier", "positive", [source], [
    ...kindRows("question", q, "Which mortar resists rain?"), row(q,"question.status",voc("question/open")), row(q,"question.motivates",obj(p)), row(q,"gap.about",obj(c)), row(q,"gap.kind",voc("gap/missing_information")), row(q,"question.candidate_answer",lit("lime mortar")),
  ].map(value => value.predicate === "question.candidate_answer" ? prose(value) : [value]), [...kindRows("situation",p,"Wall Trial"), ...kindRows("concept",c,"Pore flow")],
  [aliases(source,"question",["Which mortar resists rain?"],"question"), aliases(source,"project",["Wall Trial"],"project"), aliases(source,"concept",["Pore flow"],"concept")]);
}
{
  const source = record("Rivet setting is a skill about the concept Metal joints. Its demonstration is Sample Kilo, its outcome is Observation Lima, and its last-validation timestamp is 2026-04-12T09:15:00Z.", [["skill","Rivet setting"],["concept","Metal joints"],["demo","Sample Kilo"],["outcome","Observation Lima"]]);
  const s = entity("skill");
  add("skill","evidence-links","positive",[source],[...kindRows("skill",s,"Rivet setting"),row(s,"skill.about",obj(entity("concept"))),row(s,"skill.demonstration",obj(entity("demo"))),row(s,"skill.outcome",obj(entity("outcome"))),row(s,"skill.last_validated",lit("2026-04-12T09:15:00Z"))].map(value=>[value]),kindRows("concept",entity("concept"),"Metal joints"),source.subjects.map(({id,quote})=>aliases(source,id,[quote],id)));
}
{
  const source = record("Basalt map is a framework. Its purpose is compare repair options. It includes the skill Rivet setting and has the procedure Gauge check as a component. It assumes stable temperature, applies to metal panels, and fails when surfaces are corroded.", [["framework","Basalt map"],["skill","Rivet setting"],["procedure","Gauge check"]]);
  const f=entity("framework");
  add("framework","structure","positive",[source],[...kindRows("framework",f,"Basalt map"),row(f,"framework.purpose",lit("compare repair options")),row(f,"framework.includes",obj(entity("skill"))),row(f,"framework.component",obj(entity("procedure"))),row(f,"framework.assumption",lit("stable temperature")),row(f,"framework.applies_to",lit("metal panels")),row(f,"framework.failure_mode",lit("surfaces are corroded"))].map(value=>value.predicate.endsWith("label")?[value]:prose(value)),[...kindRows("skill",entity("skill"),"Rivet setting"),...kindRows("procedure",entity("procedure"),"Gauge check")],source.subjects.map(({id,quote})=>aliases(source,id,[quote],id)));
}
{
  const source=record("Drift check is a procedure. Its strategy is compare two readings. It requires a clean probe, applies to sealed vessels, and needs the skill Dial reading. Its success check is matching readings. Its failure mode is a loose probe. A leaking vessel is a counterexample.",[["procedure","Drift check"],["skill","Dial reading"]]);const p=entity("procedure");
  add("procedure","conditions","positive",[source],[...kindRows("procedure",p,"Drift check"),row(p,"procedure.strategy",lit("compare two readings")),row(p,"procedure.prerequisite",lit("a clean probe")),row(p,"procedure.applies_to",lit("sealed vessels")),row(p,"procedure.required_capability",obj(entity("skill"))),row(p,"procedure.success_check",lit("matching readings")),row(p,"procedure.failure_mode",lit("a loose probe")),row(p,"procedure.counterexample",lit("A leaking vessel"))].map(value=>value.predicate.endsWith("label")?[value]:prose(value)),kindRows("skill",entity("skill"),"Dial reading"),source.subjects.map(({id,quote})=>aliases(source,id,[quote],id)));
  const v=record("Torque check is a procedure. Its last-validation timestamp is 2026-04-15T11:40:00Z. Its outcome is Observation Mike, its standard is a two-percent tolerance, and its exemplar is Trial November.",[["procedure","Torque check"],["outcome","Observation Mike"],["exemplar","Trial November"]]);
  add("procedure","validation","positive",[v],[...kindRows("procedure",p,"Torque check"),row(p,"procedure.last_validated",lit("2026-04-15T11:40:00Z")),row(p,"procedure.outcome",obj(entity("outcome"))),row(p,"procedure.standard",lit("a two-percent tolerance")),row(p,"procedure.exemplar",obj(entity("exemplar")))].map(value=>value.predicate==="procedure.standard"?prose(value):[value]),[],v.subjects.map(({id,quote})=>aliases(v,id,[quote],id)));
}
{
  const source=record("Crate delivery is an open commitment. Edda owes Finn the deliverable: a sealed sample crate.",[["commitment","Crate delivery"],["edda","Edda"],["finn","Finn"]]);const c=entity("commitment");
  add("commitment","parties","positive",[source],[...kindRows("commitment",c,"Crate delivery"),row(c,"commitment.status",voc("commitment/open")),row(c,"commitment.debtor",obj(sup("edda"))),row(c,"commitment.creditor",obj(sup("finn"))),row(c,"commitment.deliverable",lit("a sealed sample crate")),row(sup("edda"),"world.kind",voc("world/person")),row(sup("finn"),"world.kind",voc("world/person"))].map(value=>value.predicate==="commitment.deliverable"?prose(value):[value]),[row(sup("edda"),"person.label",lit("Edda")),row(sup("finn"),"person.label",lit("Finn"))],[aliases(source,"commitment",["Crate delivery"],"commitment")]);
  const relative=record("Badge return is a commitment due next Wednesday; the source provides no calendar date or timezone.",[["commitment","Badge return"]]);
  add("commitment","ungrounded-date","abstention",[relative],[],kindRows("commitment",c,"Badge return"),[aliases(relative,"commitment",["Badge return"],"commitment")]);
  const dates=record('Dispatch A and Dispatch B are distinct commitments. Edda states her own belief: "Dispatch A is due on 2026-04-20." Finn states his own belief: "Dispatch A is due on 2026-04-21." Dispatch B is due on 2026-04-22.',[["a","Dispatch A and"],["b","Dispatch B are"],["edda","Edda"],["finn","Finn"]]);
  const quoteRef=(quote:string,occurrence:number)=>{let start=-1;for(let i=0;i<=occurrence;i++)start=dates.text.indexOf(quote,start+1);return `mention:r1:${start}:${start+quote.length}`;};
  add("commitment","conflicting-deadlines","perspective",[dates],[...kindRows("commitment",entity("a"),"Dispatch A"),...kindRows("commitment",entity("b"),"Dispatch B"),row(entity("a"),"commitment.due",lit("2026-04-20"),{mode:"quoted",holder:entity("edda"),speaker:entity("edda"),perspective_citations:["r1"]}),row(entity("a"),"commitment.due",lit("2026-04-21"),{mode:"quoted",holder:entity("finn"),speaker:entity("finn"),perspective_citations:["r1"]}),row(entity("b"),"commitment.due",lit("2026-04-22"))].map(value=>[value]),[...kindRows("person",sup("edda"),"Edda"),...kindRows("person",sup("finn"),"Finn")],[{key:entity("a"),refs:[sup("a"),quoteRef("Dispatch A",0),quoteRef("Dispatch A",1),quoteRef("Dispatch A",2)]},{key:entity("b"),refs:[sup("b"),quoteRef("Dispatch B",0),quoteRef("Dispatch B",1)]},aliases(dates,"edda",["Edda"],"edda"),aliases(dates,"finn",["Finn"],"finn")]);
  const tentative=record('The decision Shade selection remains open. We might decide to use copper; no choice has been made.',[["decision","Shade selection"]]);const d=entity("decision");
  add("decision","tentative","perspective",[tentative],[...kindRows("decision",d,"Shade selection").map(value=>[value]),[row(d,"decision.status",voc("decision/open"))]],[row(d,"decision.status",voc("decision/decided"),{mode:"suggested"}),row(d,"decision.status",voc("decision/decided"),{mode:"hypothetical"}),row(d,"decision.status",voc("decision/decided"),{polarity:"negative"})],[aliases(tentative,"decision",["Shade selection"],"decision")]);
}
{
  const source=record("The situation Roof Survey has commitment Sample Return and decision Tile Choice. It requires situation Ladder Setup, enables situation Seal Review, blocks situation Yard Closure, and is invalidated by a withdrawn access permit.",[["situation","Roof Survey"],["commitment","Sample Return"],["decision","Tile Choice"],["requires","Ladder Setup"],["enables","Seal Review"],["blocks","Yard Closure"]]);const s=entity("situation");
  add("situation","dependencies","positive",[source],[...kindRows("situation",s,"Roof Survey"),row(s,"situation.has_commitment",obj(entity("commitment"))),row(s,"situation.has_decision",obj(entity("decision"))),row(s,"situation.requires",obj(entity("requires"))),row(s,"situation.enables",obj(entity("enables"))),row(s,"situation.blocks",obj(entity("blocks"))),row(s,"situation.invalidated_by",lit("a withdrawn access permit"))].map(value=>value.predicate==="situation.invalidated_by"?prose(value):[value]),[...kindRows("commitment",entity("commitment"),"Sample Return"),...kindRows("decision",entity("decision"),"Tile Choice"),...[["requires","Ladder Setup"],["enables","Seal Review"],["blocks","Yard Closure"]].flatMap(([id,label])=>kindRows("situation",entity(id!),label!))],source.subjects.map(({id,quote})=>aliases(source,id,[quote],id)));
}
// Exactly five fresh conditional-grounding cases. Host context records are not additional witnesses.
{
  const left=`g${"b".repeat(64)}/0`,right=`g${"b".repeat(64)}/1`;
  const prior=(id:string,text:string,handle:string,label:string)=>record(text,[[handle,label]],id);
  const pair=[prior("prior-a","Loop lock is a mechanism that holds a gate closed.",left,"Loop lock"),prior("prior-b","Gate catch is a mechanism that holds a gate closed.",right,"Gate catch")];
  for(const retained of [false,true]){
    const witness=record("Loop lock is the same concept as Gate catch.",[],"witness"),a=mentionRef(witness,"Loop lock"),b=mentionRef(witness,"Gate catch");
    cases.push({id:`concept-grounding-${retained?"retained-label":"compatible"}-v2`,kind:"concept",family:"positive",records:[retained?prior("prior-a","The earlier label Loop lock denoted a gate-closing mechanism.",left,"Loop lock"):pair[0]!,pair[1]!,witness],nominations:[{mention:a,supplied:left},{mention:b,supplied:right}],required:[[row(a,"concept.same_as",obj(b),{citations:["witness"]})]],optional:[...kindRows("concept",a,"Loop lock"),...kindRows("concept",b,"Gate catch")].map(value=>({...value,citations:["witness"]}))});
  }
  add("concept","grounding-homonym","abstention",[prior("prior-a","Cairn is a sorting technique.",left,"Cairn"),prior("prior-b","Cairn is a cooling technique.",right,"Cairn"),record("Cairn is mentioned with no indication of which meaning is intended. No identity relationship is asserted.",[],"witness")],[]);
  add("concept","grounding-missing-proof","abstention",[pair[0]!,record("The second endpoint's proof is unavailable. There is no evidence that Loop lock denotes another catalog concept.",[],"witness")],[]);
  add("concept","grounding-quoted-labels","abstention",[...pair,record('A copied list contains the labels "Loop lock" and "Gate catch" without stating a relationship.',[],"witness")],[]);
}
export const qualificationCorpus: QualificationCorpus = { schema: "kizuki.world-qualification-corpus/v2", synthetic: true, split: "held_out", version: "world-kinds-20261021-v2", cases };
