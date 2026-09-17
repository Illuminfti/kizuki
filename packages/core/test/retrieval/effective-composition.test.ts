import { describe, expect, test } from "bun:test";
import {
  FTS5_RETRIEVAL_DESCRIPTOR,
  PortError,
  PROVENANCE_ERASURE_CAPABILITY,
  RETRIEVAL_CAPABILITIES,
  validateRetrievalQuery,
} from "../../src/index";

const LEXICAL_QUERY = {
  text: "composition-probe",
  scope: {},
  ceiling: "private" as const,
  limit: 10,
  deadline_ms: 1_000,
};

describe("effective retrieval composition (#528 RI-01)", () => {
  test("the retrieval contract has no rerank capability or query mode", () => {
    expect(RETRIEVAL_CAPABILITIES).toEqual([
      "lexical",
      "vector",
      "hybrid",
      "graph",
      PROVENANCE_ERASURE_CAPABILITY,
    ]);
    expect(RETRIEVAL_CAPABILITIES).not.toContain("rerank");
    expect(validateRetrievalQuery({ ...LEXICAL_QUERY, mode: "lexical" }).mode).toBe("lexical");
    expect(validateRetrievalQuery({ ...LEXICAL_QUERY, mode: "vector" }).mode).toBe("vector");
    expect(validateRetrievalQuery({ ...LEXICAL_QUERY, mode: "hybrid" }).mode).toBe("hybrid");
    expect(() => validateRetrievalQuery({ ...LEXICAL_QUERY, mode: "rerank" })).toThrow(PortError);
  });

  test("the default FTS5 descriptor is lexical only", () => {
    expect(FTS5_RETRIEVAL_DESCRIPTOR.id).toBe("kizuki.retrieval.fts5");
    expect(FTS5_RETRIEVAL_DESCRIPTOR.supports).toEqual([
      "lexical",
      PROVENANCE_ERASURE_CAPABILITY,
    ]);
    expect(FTS5_RETRIEVAL_DESCRIPTOR.supports).not.toContain("vector");
    expect(FTS5_RETRIEVAL_DESCRIPTOR.supports).not.toContain("rerank");
  });
});
