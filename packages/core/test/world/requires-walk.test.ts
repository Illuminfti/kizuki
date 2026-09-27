import { describe, expect, test } from "bun:test";
import {
  explainRequiresImpact,
  REQUIRES_PREDICATE,
  RequiresWalkError,
} from "../../src/world/requires-walk";
import type { RequiresFact } from "../../src/world/requires-walk";

const BOUND = { max_nodes: 8, max_depth: 4 };

const CHAIN: RequiresFact[] = [
  {
    claim_id: "claim-method",
    predicate: REQUIRES_PREDICATE,
    polarity: "positive",
    dependent_id: "concept.method",
    required_id: "concept.assumption",
    event_ids: ["event-method"],
  },
  {
    claim_id: "claim-conclusion",
    predicate: REQUIRES_PREDICATE,
    polarity: "positive",
    dependent_id: "concept.conclusion",
    required_id: "concept.method",
    event_ids: ["event-conclusion"],
  },
];

function refusal(run: () => unknown): RequiresWalkError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequiresWalkError) return error;
    throw error;
  }
  throw new Error("expected a RequiresWalkError");
}

describe("native concept.requires impact", () => {
  test("one chain names current dependents and their witnesses", () => {
    expect(
      explainRequiresImpact(CHAIN, "concept.assumption", BOUND),
    ).toEqual({
      changed_id: "concept.assumption",
      predicate: REQUIRES_PREDICATE,
      current: [
        {
          id: "concept.method",
          depth: 1,
          via: [{ claim_id: "claim-method", event_ids: ["event-method"] }],
        },
        {
          id: "concept.conclusion",
          depth: 2,
          via: [
            { claim_id: "claim-method", event_ids: ["event-method"] },
            { claim_id: "claim-conclusion", event_ids: ["event-conclusion"] },
          ],
        },
      ],
      withdrawn: [],
      truncated: false,
      cycle: null,
    });
  });

  test("a negative edge withdraws the direct dependent and does not keep the old chain", () => {
    const corrected: RequiresFact[] = [
      {
        claim_id: "claim-method-withdrawn",
        predicate: REQUIRES_PREDICATE,
        polarity: "negative",
        dependent_id: "concept.method",
        required_id: "concept.assumption",
        event_ids: ["event-correction"],
      },
      CHAIN[1]!,
    ];
    const impact = explainRequiresImpact(
      corrected,
      "concept.assumption",
      BOUND,
    );
    expect(impact.current).toEqual([]);
    expect(impact.withdrawn).toEqual([
      {
        id: "concept.method",
        depth: 1,
        via: [
          {
            claim_id: "claim-method-withdrawn",
            event_ids: ["event-correction"],
          },
        ],
      },
    ]);
    expect(impact.current.map((node) => node.id)).not.toContain(
      "concept.conclusion",
    );
    expect(impact.withdrawn.map((node) => node.id)).not.toContain(
      "concept.conclusion",
    );
  });

  test("an unknown predicate, a non-dependency, and both polarities refuse", () => {
    expect(
      refusal(() =>
        explainRequiresImpact(
          [{ ...CHAIN[0]!, predicate: "concept.invented" }],
          "concept.assumption",
          BOUND,
        ),
      ).code,
    ).toBe("unknown_predicate");
    expect(
      refusal(() =>
        explainRequiresImpact(
          [{ ...CHAIN[0]!, predicate: "concept.distinguished_from" }],
          "concept.assumption",
          BOUND,
        ),
      ).code,
    ).toBe("unsupported_operator");
    expect(
      refusal(() =>
        explainRequiresImpact(
          [
            CHAIN[0]!,
            {
              ...CHAIN[0]!,
              claim_id: "claim-method-negative",
              polarity: "negative",
              event_ids: ["event-correction"],
            },
          ],
          "concept.assumption",
          BOUND,
        ),
      ).code,
    ).toBe("ambiguous");
  });

  test("a node cap stops the chain and says so", () => {
    const impact = explainRequiresImpact(CHAIN, "concept.assumption", {
      max_nodes: 1,
      max_depth: 4,
    });
    expect(impact.current.map((node) => node.id)).toEqual(["concept.method"]);
    expect(impact.truncated).toBe(true);
    expect(JSON.stringify(impact)).not.toContain("concept.conclusion");
  });

  test("a cycle is reported once and does not loop", () => {
    const impact = explainRequiresImpact(
      [
        {
          claim_id: "claim-b",
          predicate: REQUIRES_PREDICATE,
          polarity: "positive",
          dependent_id: "concept.b",
          required_id: "concept.a",
          event_ids: ["event-b"],
        },
        {
          claim_id: "claim-a",
          predicate: REQUIRES_PREDICATE,
          polarity: "positive",
          dependent_id: "concept.a",
          required_id: "concept.b",
          event_ids: ["event-a"],
        },
      ],
      "concept.a",
      BOUND,
    );
    expect(impact.current.map((node) => node.id)).toEqual(["concept.b"]);
    expect(impact.cycle).toEqual(["concept.a", "concept.b", "concept.a"]);
    expect(impact.truncated).toBe(false);
  });
});
