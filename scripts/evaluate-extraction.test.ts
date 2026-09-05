import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  corpusDigest, loadCorpus, loadResponseSet, scoreExtraction,
  validateCorpus, validateResponseSet,
} from "./evaluate-extraction";

const fixtures = join(import.meta.dir, "fixtures");
const corpusPath = join(fixtures, "extraction-quality-v1.json");
const responsesPath = join(fixtures, "extraction-quality-scripted-v1.json");
const corpus = loadCorpus(corpusPath);
const reference = loadResponseSet(responsesPath, corpus);

function changed(change: (value: any) => void) {
  const value = JSON.parse(readFileSync(responsesPath, "utf8"));
  change(value);
  return validateResponseSet(value, corpus);
}

describe("independent extraction answer key", () => {
  test("the authored reference recovers every positive tuple and every real abstention", () => {
    const result = scoreExtraction(corpus, reference);
    expect(result.complete).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.mode).toBe("scripted_contract");
    expect(result.model_quality_claim).toBe(false);
    expect(result.metrics.tuple_precision).toEqual({ numerator: 11, denominator: 11, value: 1 });
    expect(result.metrics.tuple_recall).toEqual({ numerator: 11, denominator: 11, value: 1 });
    expect(result.metrics.abstention_recall).toEqual({ numerator: 5, denominator: 5, value: 1 });
    expect(result.usage.input_tokens).toBeNull();
    expect(result.usage.unknown_usage_cases).toBe(12);
  });

  test("always-empty and the same answer everywhere cannot pass", () => {
    const empty = changed((value) => { for (const row of value.responses) row.response.claims = []; });
    expect(scoreExtraction(corpus, empty).passed).toBe(false);
    expect(scoreExtraction(corpus, empty).metrics.tuple_recall.value).toBe(0);
    const same = changed((value) => { for (const row of value.responses) row.response = structuredClone(value.responses[0].response); });
    expect(scoreExtraction(corpus, same).passed).toBe(false);
  });

  test("valid event and subject IDs cannot support a fabricated proposition", () => {
    const value = changed((set) => {
      const claim = structuredClone(set.responses[10].response.claims[0]);
      claim.predicate = "employment.role";
      claim.object = "Nobel laureate";
      claim.body = "Mira won a Nobel Prize.";
      claim.confidence = 1;
      set.responses[10].response.claims.push(claim);
    });
    const result = scoreExtraction(corpus, value);
    expect(result.passed).toBe(false);
    expect(result.cases[10]?.false_positive).toBe(1);
  });

  test("sender and recipient inversions fail although both people belong to the cited records", () => {
    const value = changed((set) => {
      set.responses[9].response.claims[0].subject = "quality:grace";
      set.responses[9].response.claims[1].subject = "quality:ada";
    });
    const row = scoreExtraction(corpus, value).cases[9]!;
    expect(row.false_positive).toBe(2);
    expect(row.false_negative).toBe(2);
    expect(row.failures).toContain("subject_support");
  });

  test.each(["polarity", "valid_from", "event_ids"])("wrong %s loses supported-tuple credit", (field) => {
    const value = changed((set) => {
      const claim = set.responses[1].response.claims[0];
      if (field === "polarity") claim.polarity = "negative";
      if (field === "valid_from") claim.valid_from = "2026-07-01T00:00:00.000Z";
      if (field === "event_ids") claim.event_ids = ["q01-a"];
    });
    expect(scoreExtraction(corpus, value).cases[1]?.false_positive).toBe(1);
  });

  test("extra identical claims are false positives; confidence alone never improves a score", () => {
    const value = changed((set) => {
      set.responses[0].response.claims.push(structuredClone(set.responses[0].response.claims[0]));
      set.responses[0].response.claims[1].confidence = 1;
    });
    expect(scoreExtraction(corpus, value).cases[0]?.false_positive).toBe(1);
  });

  test("novel body prose requires an annotation even when its tuple matches", () => {
    const value = changed((set) => { set.responses[0].response.claims[0].body = "Ada coordinates Orchard and secretly owns every library."; });
    const result = scoreExtraction(corpus, value);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.failures).toContain("unscored_requires_annotation");
  });

  test("under-labeling is counted separately and cannot pass", () => {
    const value = changed((set) => { set.responses[0].response.claims[0].sensitivity = "public"; });
    const result = scoreExtraction(corpus, value);
    expect(result.metrics.tuple_precision.value).toBe(1);
    expect(result.metrics.sensitivity_under_labels).toBe(1);
    expect(result.passed).toBe(false);
  });

  test.each(["unavailable", "rejected", "denied", "refusal"])("%s is not successful empty extraction", (status) => {
    const value = changed((set) => {
      set.responses[4].status = status;
      set.responses[4].response = null;
    });
    const result = scoreExtraction(corpus, value);
    expect(result.metrics.abstention_recall.numerator).toBe(4);
    expect(result.status_counts[status]).toBe(1);
    expect(result.passed).toBe(false);
  });

  test("a dropped response is not an abstention, and malformed JSON is scored as schema failure", () => {
    const dropped = changed((set) => { set.responses[4].dropped = 1; });
    expect(scoreExtraction(corpus, dropped).metrics.abstention_recall.numerator).toBe(4);
    const malformed = changed((set) => { set.responses[4].response = "malformed"; });
    const result = scoreExtraction(corpus, malformed);
    expect(result.cases[4]?.failures).toContain("schema_invalid");
    expect(result.metrics.abstention_recall.numerator).toBe(4);
  });
});

describe("bounded and attributable input", () => {
  test.each(["missing", "duplicate", "unknown"])("%s cases refuse instead of changing a denominator", (kind) => {
    expect(() => changed((value) => {
      if (kind === "missing") value.responses.pop();
      if (kind === "duplicate") value.responses[11].case_id = "q01";
      if (kind === "unknown") value.responses[11].case_id = "invented";
    })).toThrow();
  });

  test("corpus changes invalidate recorded response binding", () => {
    const value = JSON.parse(readFileSync(corpusPath, "utf8"));
    value.cases[0].records[0].text = "Ada does something else.";
    const revised = validateCorpus(value);
    expect(corpusDigest(revised)).not.toBe(corpusDigest(corpus));
    expect(() => validateResponseSet(reference, revised)).toThrow("corpus hash mismatch");
  });

  test("missing annotations, impossible gold citations, and a reduced answer-key case list refuse", () => {
    for (const mutate of [
      (value: any) => { value.cases[0].expected[0].bodies = []; },
      (value: any) => { value.cases[0].expected[0].citation_sets = [["q10-a"]]; },
      (value: any) => { value.cases.pop(); },
    ]) {
      const value = JSON.parse(readFileSync(corpusPath, "utf8"));
      mutate(value);
      expect(() => validateCorpus(value)).toThrow();
    }
  });

  test("a mode label cannot attest fabricated model provenance", () => {
    expect(() => changed((value) => { value.mode = "recorded_model"; })).toThrow("recorded model provenance is unsupported");
  });

  test.each([-1, 2, 1.1, 1e12])("invalid or exceeded per-case call budget %s refuses", (calls) => {
    expect(() => changed((value) => { value.responses[0].usage.calls = calls; })).toThrow();
  });

  test("unknown usage stays unknown and cannot be confused with measured zero", () => {
    const measured = changed((value) => {
      for (const row of value.responses) row.usage = { calls: 1, input_tokens: 0, output_tokens: 0 };
    });
    expect(scoreExtraction(corpus, measured).usage).toMatchObject({ input_tokens: 0, output_tokens: 0, unknown_usage_cases: 0 });
    expect(scoreExtraction(corpus, reference).usage.input_tokens).toBeNull();
  });
});
