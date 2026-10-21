export type PrincipalName = "owner" | "scoped_agent";
export type Surface = "session_hook" | "context_packet" | "search" | "world_view";
export type PersonaSize = "small" | "full";

export interface Fact {
  id: string;
  value: string;
  state: "current" | "stale";
  access: "shared" | "owner_only" | "withheld";
}

export interface Question {
  id: string;
  text: string;
  query: string;
  gold_fact_ids: string[];
  world: { kind: "concept" | "situation"; label: string };
}

export interface RecordSpec {
  id: string;
  subject: string;
  label: string;
  at: string;
  claims: { predicate: string; value: string; mode?: "uncertain"; until?: string }[];
  kind?: "concept" | "situation";
  sensitivity?: "private";
  withheld?: true;
}

export const AS_OF = "2026-09-30T12:00:00.000Z";
const BEFORE = "2026-09-24T12:00:00.000Z";
const NOW = "2026-09-29T12:00:00.000Z";

/** Logical IDs belong only to the oracle; none is embedded in served fact text. */
export function persona(size: PersonaSize) {
  const facts: Fact[] = [
    { id: "owner-role", value: "municipal bridge engineer", state: "current", access: "shared" },
    { id: "collaborator", value: "Grace coordinates the Orchard survey team", state: "current", access: "shared" },
    { id: "proposed-relationship", value: "Ada collaborates with Grace", state: "current", access: "owner_only" },
    { id: "objective", value: "restore the orchard footbridge", state: "current", access: "shared" },
    { id: "commitment", value: "deliver the survey by 2026-10-04", state: "current", access: "shared" },
    { id: "old-blocker", value: "waiting for the timber permit", state: "stale", access: "shared" },
    { id: "mistaken-blocker", value: "waiting for the paint samples", state: "stale", access: "shared" },
    { id: "change", value: "the timber permit arrived on 2026-09-28", state: "current", access: "shared" },
    { id: "corrected-blocker", value: "waiting for the load test", state: "current", access: "owner_only" },
    { id: "priority", value: "accessible routes before decorative lighting", state: "current", access: "shared" },
    { id: "decision", value: "reuse the stone piers to reduce waste", state: "current", access: "shared" },
    { id: "uncertainty", value: "the flood estimate is unverified", state: "current", access: "shared" },
    { id: "conflict-a", value: "the east bank soil is stable", state: "current", access: "shared" },
    { id: "conflict-b", value: "the east bank soil may be unstable", state: "current", access: "shared" },
    { id: "knowledge", value: "update confidence when new evidence arrives", state: "current", access: "shared" },
    { id: "learning", value: "practice flood modelling with held out examples", state: "current", access: "shared" },
    { id: "skill", value: "independent inspection of steel joints", state: "current", access: "shared" },
    { id: "scope-decoy", value: "family reserve uses the violet envelope", state: "current", access: "owner_only" },
    { id: "ceiling-decoy", value: "Orchard medical reserve uses the amber envelope", state: "current", access: "owner_only" },
    { id: "consent-decoy", value: "Orchard sealed sponsor uses the lavender envelope", state: "current", access: "withheld" },
  ];
  const value = (id: string) => facts.find(fact => fact.id === id)!.value;
  const records: RecordSpec[] = [
    { id: "identity", subject: "ada", label: "Ada", at: BEFORE, claims: [
      { predicate: "employment.role", value: value("owner-role") },
      { predicate: "skill.has", value: value("skill") },
      { predicate: "preference.prefers", value: value("priority") },
    ] },
    { id: "team", subject: "grace", label: "Grace", at: BEFORE, claims: [
      { predicate: "employment.role", value: value("collaborator") },
    ] },
    { id: "project-before", subject: "orchard", label: "Orchard", at: BEFORE, kind: "situation", claims: [
      { predicate: "situation.objective", value: value("objective") },
      { predicate: "situation.blocker", value: value("old-blocker"), until: "2026-09-28T12:00:00.000Z" },
      { predicate: "situation.commitment", value: value("commitment") },
      { predicate: "decision.decided", value: value("decision") },
    ] },
    { id: "project-now", subject: "orchard", label: "Orchard", at: NOW, kind: "situation", claims: [
      { predicate: "situation.change", value: value("change") },
      { predicate: "situation.blocker", value: value("mistaken-blocker") },
      { predicate: "situation.objective", value: value("uncertainty"), mode: "uncertain" },
    ] },
    { id: "survey-a", subject: "orchard", label: "Orchard", at: NOW, claims: [
      { predicate: "project.status", value: value("conflict-a") },
    ] },
    { id: "survey-b", subject: "orchard", label: "Orchard", at: NOW, claims: [
      { predicate: "project.status", value: value("conflict-b") },
    ] },
    { id: "method", subject: "bayes", label: "Bayes", at: NOW, kind: "concept", claims: [
      { predicate: "concept.definition", value: value("knowledge") },
      { predicate: "concept.example", value: value("learning") },
    ] },
    { id: "scope-decoy", subject: "family", label: "Family", at: NOW, kind: "situation", claims: [
      { predicate: "situation.objective", value: value("scope-decoy") },
    ] },
    { id: "ceiling-decoy", subject: "orchard", label: "Orchard", at: NOW, sensitivity: "private", kind: "situation", claims: [
      { predicate: "situation.objective", value: value("ceiling-decoy") },
    ] },
    { id: "consent-decoy", subject: "orchard", label: "Orchard", at: NOW, withheld: true, kind: "situation", claims: [
      { predicate: "situation.objective", value: value("consent-decoy") },
    ] },
  ];
  if (size === "full") {
    for (let index = 0; index < 6; index += 1) {
      facts.push({ id: `background-${index}`, value: `archive shelf ${index} holds the river drawings`, state: "current", access: "shared" });
      records.push({ id: `background-${index}`, subject: "ada", label: "Ada", at: BEFORE,
        claims: [{ predicate: "tool.uses", value: value(`background-${index}`) }] });
    }
  }
  const orchard = { kind: "situation" as const, label: "Orchard" };
  const bayes = { kind: "concept" as const, label: "Bayes" };
  const question = (id: string, text: string, query: string, ids: string[], world: Question["world"] = orchard): Question =>
    ({ id, text, query, gold_fact_ids: ids, world });
  const questions: Question[] = [
    question("who", "Who is this person?", "Ada", ["owner-role"]),
    question("around", "Who and what are around them?", "Grace Orchard", ["collaborator", "proposed-relationship", "objective"]),
    question("now", "What is happening now?", "Orchard", ["objective", "corrected-blocker", "commitment"]),
    question("matters", "What matters to them?", "Ada", ["priority"]),
    question("knows", "What do they know?", "Bayes", ["knowledge"], bayes),
    question("learning", "What are they learning?", "Bayes", ["learning"], bayes),
    question("skill", "What are they good at?", "Ada", ["skill"]),
    question("uncertain", "What are they uncertain about?", "Orchard", ["uncertainty", "conflict-a", "conflict-b"]),
    question("changed", "What changed recently?", "Orchard", ["change", "corrected-blocker"]),
    question("decisions", "Which decisions and frameworks matter here?", "Orchard Bayes", ["decision", "knowledge"]),
    question("blocked", "What is blocked?", "Orchard", ["corrected-blocker"]),
    question("evidence", "What evidence supports this?", "Orchard", ["objective", "commitment"]),
    question("assumptions", "What must not be assumed?", "Orchard", ["uncertainty", "corrected-blocker", "conflict-a", "conflict-b"]),
    question("scope-probe", "What can be recalled about the family reserve?", "Family", ["scope-decoy"], { kind: "situation", label: "Family" }),
    question("ceiling-probe", "What can be recalled about the medical reserve?", "Orchard", ["ceiling-decoy"]),
    question("consent-probe", "What can be recalled about the sealed sponsor?", "Orchard", ["consent-decoy"]),
  ];
  return { facts, records, questions };
}
