import { describe, expect, test } from "bun:test";
import { listValidityGaps } from "../../src/claims/gaps";
import { PREDICATE_REGISTRY, isSingleValuedPredicate } from "../../src/claims/predicates";
import { insertClaim } from "../../src/claims/store";
import { claimsDb, eventFacts, putEvent } from "./helpers";

describe("validity coverage gaps", () => {
  test("outcome predicates are registered as multi-valued", () => {
    const reached = PREDICATE_REGISTRY.find((entry) => entry.id === "outcome.reached");
    const missed = PREDICATE_REGISTRY.find((entry) => entry.id === "outcome.missed");
    expect(reached?.cardinality).toBe("multi");
    expect(missed?.cardinality).toBe("multi");
    expect(isSingleValuedPredicate("outcome.reached")).toBe(false);
  });

  test("a hole between two keyed windows is a gap, not a conflict", async () => {
    const db = claimsDb();
    const firstEvent = putEvent(db, { source_record_id: "first" });
    const secondEvent = putEvent(db, { source_record_id: "second" });
    const first = await insertClaim(
      { db },
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "Acme",
        polarity: "positive",
        body: "Ada worked at Acme.",
        provenance: [firstEvent],
        subjects: ["person:ada"],
        producer: "deterministic",
        confidence: 0.8,
        valid_from: "2020-01-01T00:00:00.000Z",
        valid_to: "2021-06-01T00:00:00.000Z",
        events: [eventFacts(firstEvent)],
      },
    );
    const second = await insertClaim(
      { db },
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "Contoso",
        polarity: "positive",
        body: "Ada later worked at Contoso.",
        provenance: [secondEvent],
        subjects: ["person:ada"],
        producer: "deterministic",
        confidence: 0.8,
        valid_from: "2022-01-01T00:00:00.000Z",
        events: [eventFacts(secondEvent)],
      },
    );
    expect(first.outcome === "stored" || first.outcome === "contested").toBe(true);
    expect(second.outcome === "stored" || second.outcome === "contested").toBe(true);
    const gaps = listValidityGaps(db, { subject: "person:ada" });
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]?.after).toBe("2021-06-01T00:00:00.000Z");
    expect(gaps[0]?.before).toBe("2022-01-01T00:00:00.000Z");
    db.close();
  });
});
