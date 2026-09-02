import { describe, expect, test } from "bun:test";
import {
  CLAIM_DEDUP_MIN,
  FIXTURE_EMBEDDING_SPACE,
  scoreClaimPair,
} from "../../src/claims/dedup";
import { insertClaim } from "../../src/claims/store";
import {
  claimInput,
  claimsDb,
  eventFacts,
  FixtureVectorPort,
  putEvent,
} from "../claims/helpers";

const DUPLICATE_LEFT = "Grace runs partnerships at Acme.";
const DUPLICATE_RIGHT = "Grace works on partnerships at Acme.";
const DISTINCT = "Linus prefers mechanical keyboards.";

describe("claim-level dedup threshold", () => {
  test("a known duplicate fixture pair scores above the threshold", () => {
    expect(
      scoreClaimPair(DUPLICATE_LEFT, DUPLICATE_RIGHT, FIXTURE_EMBEDDING_SPACE),
    ).toBeGreaterThan(CLAIM_DEDUP_MIN);
  });

  test("a known distinct fixture pair scores below the threshold", () => {
    expect(
      scoreClaimPair(DUPLICATE_LEFT, DISTINCT, FIXTURE_EMBEDDING_SPACE),
    ).toBeLessThan(CLAIM_DEDUP_MIN);
  });

  test("structural dedup catches a re-worded duplicate that hash dedup misses", async () => {
    const db = claimsDb();
    const eventId = putEvent(db);
    const first = await insertClaim(
      { db },
      claimInput(eventId, {
        body: "Grace runs partnerships at Acme.",
        object: "Acme",
        events: [eventFacts(eventId)],
      }),
    );
    expect(first.outcome).toBe("stored");
    if (first.outcome !== "stored") return;

    const second = await insertClaim(
      { db },
      claimInput(eventId, {
        body: "Employment note: grace is based at acme.",
        object: "acme.",
        events: [eventFacts(eventId)],
      }),
    );
    expect(first.claim.body_hash).not.toBe(
      new Bun.CryptoHasher("sha256")
        .update("Employment note: grace is based at acme.")
        .digest("hex"),
    );
    expect(second.outcome).toBe("duplicate");
    if (second.outcome !== "duplicate") return;
    expect(second.claim.claim_id).toBe(first.claim.claim_id);
    expect(second.claim.corroboration).toBe(2);
    db.close();
  });

  test("dedup degrades to structural-only and says so when the vector lane is off", async () => {
    const db = claimsDb();
    const eventId = putEvent(db);
    const off = new FixtureVectorPort({ vector: false, health: "degraded" });
    const stored = await insertClaim(
      { db, retrieval: off },
      claimInput(eventId, {
        body: DUPLICATE_LEFT,
        events: [eventFacts(eventId)],
      }),
    );
    expect(stored.dedup).toBe("structural-only");

    const reworded = await insertClaim(
      { db, retrieval: off },
      claimInput(eventId, {
        body: "A reworded employment claim about Acme.",
        object: "ACME!",
        events: [eventFacts(eventId)],
      }),
    );
    expect(reworded.outcome).toBe("duplicate");
    expect(reworded.dedup).toBe("structural-only");
    db.close();
  });
});
