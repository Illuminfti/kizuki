import { describe, expect, test } from "bun:test";
import { indexEvent } from "../../src/search/indexer";
import { search, searchResult } from "../../src/search/query";
import { toRelaxedFtsQuery } from "../../src/search/relax";
import { searchDb, storedEvent } from "./helpers";

const RECORDS: [string, string][] = [
  ["launch-mm", "Decision: we will onboard two market makers before the public launch."],
  ["launch-date", "The launch date moved to the second week of March."],
  ["kettle", "The kettle is on and the biscuits are out."],
  ["pricing", "Pricing for the hosted tier stays flat through the first year."],
  ["travel", "Flights to Lisbon are booked for the offsite."],
];

function corpus() {
  const db = searchDb();
  const ids = new Map<string, string>();
  for (const [record, text] of RECORDS) {
    const event = storedEvent(db, record, { text, sensitivity_hint: "personal" });
    ids.set(record, `event:${event.event_id}`);
    indexEvent(db, event);
  }
  return { db, ids };
}

const OPTIONS = { ceiling: "private", scope: "ledger" } as const;

describe("toRelaxedFtsQuery", () => {
  test("drops stopwords and ORs the content words of a question", () => {
    const relaxed = toRelaxedFtsQuery("What did we decide about market makers for the launch?");
    expect(relaxed?.terms).toEqual(['"decid"*', '"market"*', '"maker"*', '"launch"*']);
    expect(relaxed?.fts).toBe('"decid"* OR "market"* OR "maker"* OR "launch"*');
    expect(relaxed?.required).toBe(3);
  });

  test("leaves keyword queries, short questions, quoted phrases and stopword-only questions literal", () => {
    expect(toRelaxedFtsQuery("market makers launch")).toBeNull();
    expect(toRelaxedFtsQuery("what is this")).toBeNull();
    expect(toRelaxedFtsQuery("what about the")).toBeNull();
    expect(toRelaxedFtsQuery('what did "market makers" do?')).toBeNull();
    expect(toRelaxedFtsQuery("what is tele*?")).toBeNull();
  });

  test("treats a leading question or instruction word as question-shaped without a question mark", () => {
    expect(toRelaxedFtsQuery("tell me the launch date")?.terms).toEqual(['"launch"*', '"date"*']);
  });
});

describe("relaxed question search", () => {
  test("a paraphrased decision question finds the decision the AND query misses", () => {
    const { db, ids } = corpus();
    const question = "What did we decide about market makers for the launch?";
    expect(search(db, "what did we decide about the market makers", OPTIONS)).toHaveLength(1);
    const result = searchResult(db, question, OPTIONS);
    expect(result.hits[0]?.doc_id).toBe(ids.get("launch-mm"));
    expect(result.degraded).toEqual(["query-relaxed"]);
  });

  test("every relaxed hit carries the fraction of content terms it matched", () => {
    const { db } = corpus();
    const result = searchResult(db, "When is the launch date and who is the auditor?", OPTIONS);
    const scores = result.hits.map((hit) => hit.coverage);
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("a hit that lacks most of the content terms is dropped", () => {
    const { db } = corpus();
    // "lisbon" alone matches one record, but it is one of four content terms.
    const result = searchResult(db, "What is the weather in Lisbon tomorrow?", OPTIONS);
    expect(result.hits).toEqual([]);
  });

  test("an unanswerable question returns an explicit no-match", () => {
    const { db } = corpus();
    const result = searchResult(db, "What is the airspeed velocity of an unladen swallow?", OPTIONS);
    expect(result.hits).toEqual([]);
    expect(result.degraded).toEqual(["query-relaxed", "query-no-match"]);
  });

  test("a literal query that already has matches is not relaxed", () => {
    const { db } = corpus();
    for (const text of ["launch one", "launch two", "launch three"]) {
      indexEvent(db, storedEvent(db, text, { text: `Is the ${text} ready?`, sensitivity_hint: "personal" }));
    }
    const result = searchResult(db, "Is the launch ready?", OPTIONS);
    expect(result.hits).toHaveLength(3);
    expect(result.degraded).toEqual([]);
    expect(result.hits.every((hit) => hit.coverage === 1)).toBe(true);
  });

  test("a keyword query with no match stays empty and unlabelled", () => {
    const { db } = corpus();
    const result = searchResult(db, "unladen swallow velocity", OPTIONS);
    expect(result).toEqual({ hits: [], degraded: [] });
  });
});
