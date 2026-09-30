import { expect, test } from "bun:test";
import { markdownAtoms, scoreObservation, worldAtoms } from "./score";
import type { Fact, Question } from "./persona";

const facts: Fact[] = [
  { id: "new", value: "the bridge is open", state: "current", access: "shared" },
  { id: "old", value: "the bridge is closed", state: "stale", access: "shared" },
  { id: "private", value: "the amber reserve", state: "current", access: "owner_only" },
  { id: "withheld", value: "the violet reserve", state: "current", access: "withheld" },
];
const question: Question = { id: "now", text: "What now?", query: "bridge", gold_fact_ids: ["new", "private", "withheld"], world: { kind: "situation", label: "Bridge" } };

test("scorer uses authorized current gold, unique facts and local citations; leaks scan metadata too", () => {
  const observation = { output: "the bridge is open; the bridge is closed; metadata: the violet reserve; the amber reserve",
    atoms: [{ text: "The BRIDGE is open", cited: false }, { text: "the bridge is open", cited: false },
      { text: "the bridge is closed", cited: true }, { text: "unrelated evidence", cited: true }], status: "ok" };
  const agent = scoreObservation(facts, question, "scoped_agent", "search", observation);
  expect(agent).toMatchObject({ expected: 1, recalled: 1, returned: 2, stale: 1, fact_recall: 1,
    stale_fact_rate: 0.5, leak_count: 2, provenance_rate: 0.5 });
  expect(agent.leaked_fact_ids).toEqual(["private", "withheld"]);
  expect(agent.tokens_used).toBeGreaterThan(0);
  expect(scoreObservation(facts, question, "owner", "search", observation)).toMatchObject({ expected: 2, fact_recall: 0.5, leak_count: 1 });
  expect(scoreObservation(facts, question, "scoped_agent", "search", observation)).toEqual(agent);
});

test("zero denominators stay n/a and a refused surface remains a visible failure", () => {
  const score = scoreObservation(facts, { ...question, gold_fact_ids: ["withheld"] }, "owner", "session_hook", { output: "", atoms: [], status: "skip:unavailable" });
  expect(score).toMatchObject({ fact_recall: null, stale_fact_rate: null, provenance_rate: null, tokens_used: 0, status: "skip:unavailable" });
});

test("Markdown and world atoms cannot borrow a sibling's citation", () => {
  const md = "- [claim:01ARZ3NDEKTSV4RRFFQ69G5FAV] the bridge is closed\n- [claim:] the bridge is open";
  const score = scoreObservation(facts, question, "owner", "context_packet", { output: md, atoms: markdownAtoms(md), status: "ok" });
  expect(score.cited).toBe(1);
  const world = [{ object: { kind: "literal", value: "the bridge is closed" }, assessments: [{ evidence: [{ eventVersion: { kind: "event_version", token: "A".repeat(43) } }] }] },
    { object: { kind: "literal", value: "the bridge is open" }, assessments: [] }];
  expect(worldAtoms(world)).toEqual([{ text: "the bridge is closed", cited: true }, { text: "the bridge is open", cited: false }]);
});
