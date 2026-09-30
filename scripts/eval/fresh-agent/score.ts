import type { Fact, PrincipalName, Question, Surface } from "./persona";
import { packetTokens } from "../../../packages/core/src/serving/packet-tokenizer";

export interface Atom { text: string; cited: boolean }
export interface Observation { output: string; atoms: Atom[]; status: string }

export interface Score {
  principal: PrincipalName;
  surface: Surface;
  question_id: string;
  status: string;
  expected: number;
  recalled: number;
  fact_recall: number | null;
  returned: number;
  stale: number;
  stale_fact_rate: number | null;
  leak_count: number;
  cited: number;
  provenance_rate: number | null;
  tokens_used: number;
  recalled_fact_ids: string[];
  missing_fact_ids: string[];
  stale_fact_ids: string[];
  leaked_fact_ids: string[];
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
function contains(text: string, fact: Fact): boolean {
  return normalize(text).includes(normalize(fact.value));
}
export const permitted = (fact: Fact, principal: PrincipalName) =>
  fact.access === "shared" || (fact.access === "owner_only" && principal === "owner");

/** Inspect decoded strings too: JSON escaping must not conceal a forbidden value. */
function leakTexts(output: string): string[] {
  const texts = [output];
  let parsed: unknown;
  try { parsed = JSON.parse(output); }
  catch { return texts; } // Hook Markdown is plain text.
  const visit = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) { texts.push(key); visit(item); }
    }
  };
  visit(parsed);
  return texts;
}

export function scoreObservation(facts: Fact[], question: Question, principal: PrincipalName, surface: Surface, observation: Observation): Score {
  const expected = facts.filter(fact => fact.state === "current" && permitted(fact, principal) && question.gold_fact_ids.includes(fact.id));
  const returned = facts.filter(fact => observation.atoms.some(atom => contains(atom.text, fact)));
  const recalled = expected.filter(fact => returned.includes(fact));
  const stale = returned.filter(fact => fact.state === "stale");
  // Scan every output byte, including metadata, even when no scoreable atom carries it.
  const outputs = leakTexts(observation.output);
  const leaked = facts.filter(fact => !permitted(fact, principal) && outputs.some(output => contains(output, fact)));
  const cited = returned.filter(fact => observation.atoms.some(atom => atom.cited && contains(atom.text, fact)));
  return { principal, surface, question_id: question.id, status: observation.status,
    expected: expected.length, recalled: recalled.length, fact_recall: rate(recalled.length, expected.length),
    returned: returned.length, stale: stale.length, stale_fact_rate: rate(stale.length, returned.length),
    leak_count: leaked.length, cited: cited.length, provenance_rate: rate(cited.length, returned.length),
    tokens_used: packetTokens(observation.output), recalled_fact_ids: recalled.map(fact => fact.id),
    missing_fact_ids: expected.filter(fact => !recalled.includes(fact)).map(fact => fact.id),
    stale_fact_ids: stale.map(fact => fact.id), leaked_fact_ids: leaked.map(fact => fact.id) };
}

export const rate = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;

/** Markdown citations stay on their own atom; a cited sibling cannot confer provenance. */
export function markdownAtoms(output: string): Atom[] {
  return output.split(/\n(?=- \[(?:page|event|claim):|## )/).map(text => ({
    text, cited: /\[(?:page|event|claim):[0-9A-HJKMNP-TV-Z]{26}\]|\bev:[0-9A-HJKMNP-TV-Z]{26}\b/.test(text),
  }));
}

/** Relations carry assessments/evidence; labels carry an addressable claim reference. */
export function worldAtoms(value: unknown): Atom[] {
  const atoms: Atom[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (typeof item !== "object" || item === null) return;
    const obj = item as Record<string, unknown>;
    const claim = obj.claim as { kind?: unknown; token?: unknown } | undefined;
    if (typeof obj.text === "string") atoms.push({ text: obj.text, cited: claim?.kind === "claim" && typeof claim.token === "string" });
    const object = obj.object as { kind?: unknown; value?: unknown } | undefined;
    if (object?.kind === "literal" && typeof object.value === "string") {
      const assessments = obj.assessments as Array<{ evidence?: Array<{ eventVersion?: { kind?: unknown; token?: unknown } }> }> | undefined;
      const cited = assessments?.some(assessment => assessment.evidence?.some(evidence =>
        evidence.eventVersion?.kind === "event_version" && typeof evidence.eventVersion.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(evidence.eventVersion.token))) ?? false;
      atoms.push({ text: object.value, cited });
    }
    Object.values(obj).forEach(visit);
  };
  visit(value);
  return atoms;
}
