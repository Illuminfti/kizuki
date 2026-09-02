import { describe, expect, test } from "bun:test";
import {
  insertClaim,
  listClaims,
  listSupersessions,
} from "../../src/claims/store";
import { SINGLE_SOURCE_CAP } from "../../src/claims/authority";
import {
  claimInput,
  claimsDb,
  corroboratedFacts,
  eventFacts,
  putEvent,
} from "./helpers";

function evidencePair(db: ReturnType<typeof claimsDb>): {
  ids: [string, string];
  facts: ReturnType<typeof corroboratedFacts>;
} {
  const first = putEvent(db, { source_record_id: "rec-a" });
  const second = putEvent(db, {
    source_record_id: "rec-b",
    connector_id: "other-fixture",
  });
  return { ids: [first, second], facts: corroboratedFacts(first, second) };
}

describe("claims authority", () => {
  test("owner correction supersedes connector evidence", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const live = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.8,
        producer: "deterministic",
        events: facts,
      }),
    );
    expect(live.outcome).toBe("stored");
    if (live.outcome !== "stored") return;

    const correction = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        body: "Grace left Acme.",
        object: "none",
        polarity: "negative",
        confidence: 1,
        producer: "owner",
        intent: "correct",
        events: facts.map((fact) => ({ ...fact, taint: "owner" as const })),
      }),
    );
    expect(correction.outcome).toBe("stored");
    if (correction.outcome !== "stored") return;
    expect(correction.claim.authority).toBe("owner_correction");
    expect(correction.superseded.map((row) => row.claim_id)).toEqual([
      live.claim.claim_id,
    ]);
    expect(listClaims(db, { status: "live" })).toHaveLength(1);
    expect(listClaims(db, { status: "superseded" })[0]?.claim_id).toBe(
      live.claim.claim_id,
    );
    expect(listSupersessions(db)[0]?.rule).toBe("R5");
    db.close();
  });

  test("model inference never supersedes connector evidence", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const live = await insertClaim(
      { db },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.7,
        producer: "deterministic",
        events: facts,
      }),
    );
    expect(live.outcome).toBe("stored");

    const incoming = await insertClaim(
      { db },
      claimInput(ids[0], {
        provenance: ids,
        body: "The model thinks Grace left Acme.",
        object: "none",
        polarity: "negative",
        confidence: 0.95,
        producer: "model",
        events: facts,
      }),
    );
    expect(incoming.outcome).toBe("skipped");
    if (incoming.outcome !== "skipped") return;
    expect(incoming.reason).toBe("below_authority");
    expect(incoming.claim.status).toBe("skipped");
    expect(listClaims(db, { status: "live" })).toHaveLength(1);
    expect(listSupersessions(db)).toEqual([]);
    db.close();
  });

  test("same tier resolves by recency then confidence then claim id", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const earlier = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        claim_id: "01CLAIM000000000000000000A",
        object: "acme",
        confidence: 0.9,
        valid_from: "2026-01-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(earlier.outcome).toBe("stored");

    const later = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        claim_id: "01CLAIM000000000000000000B",
        body: "Grace now works at Northwind.",
        object: "northwind",
        confidence: 0.5,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(later.outcome).toBe("stored");
    if (later.outcome !== "stored") return;
    expect(later.superseded[0]?.rule).toBe("R3");
    expect(listClaims(db, { status: "live" })[0]?.object).toBe("northwind");

    const tiedTime = await insertClaim(
      { db, now: () => "2026-09-02T12:02:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        claim_id: "01CLAIM000000000000000000C",
        body: "Grace works at Contoso.",
        object: "contoso",
        confidence: 0.9,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(tiedTime.outcome).toBe("stored");
    if (tiedTime.outcome !== "stored") return;
    expect(listClaims(db, { status: "live" })[0]?.object).toBe("contoso");

    const firstCorrection = await insertClaim(
      { db, now: () => "2026-09-02T12:03:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        claim_id: "01CLAIM000000000000000000E",
        predicate: "employment.role",
        object: "analyst",
        body: "Grace is an analyst.",
        producer: "owner",
        intent: "correct",
        confidence: 1,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts.map((fact) => ({ ...fact, taint: "owner" as const })),
      }),
    );
    expect(firstCorrection.outcome).toBe("stored");
    const tiedId = await insertClaim(
      { db, now: () => "2026-09-02T12:04:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        claim_id: "01CLAIM000000000000000000F",
        predicate: "employment.role",
        object: "director",
        body: "Grace is a director.",
        producer: "owner",
        intent: "correct",
        confidence: 1,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts.map((fact) => ({ ...fact, taint: "owner" as const })),
      }),
    );
    expect(tiedId.outcome).toBe("stored");
    if (tiedId.outcome !== "stored") return;
    expect(tiedId.superseded[0]?.rule).toBe("R3");
    expect(tiedId.claim.claim_id > "01CLAIM000000000000000000E").toBe(true);
    expect(
      listClaims(db, { status: "live" }).find((row) => row.predicate === "employment.role")
        ?.claim_id,
    ).toBe("01CLAIM000000000000000000F");
    db.close();
  });

  test("a contested pair within the margin leaves both claims live", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const first = await insertClaim(
      { db },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.6,
        valid_from: "2026-01-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(first.outcome).toBe("stored");

    const second = await insertClaim(
      { db },
      claimInput(ids[0], {
        provenance: ids,
        body: "Grace later joined Northwind.",
        object: "northwind",
        confidence: 0.68,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(second.outcome).toBe("contested");
    expect(listClaims(db, { status: "live" })).toHaveLength(2);
    expect(listSupersessions(db)).toEqual([]);
    db.close();
  });

  test("a single-source untrusted claim is clamped to model inference", async () => {
    const db = claimsDb();
    const eventId = putEvent(db);
    const result = await insertClaim(
      { db },
      claimInput(eventId, {
        confidence: 0.9,
        producer: "deterministic",
        events: [eventFacts(eventId, { taint: "untrusted" })],
      }),
    );
    expect(result.outcome).toBe("stored");
    if (result.outcome !== "stored") return;
    expect(result.claim.authority).toBe("model_inference");
    expect(result.claim.confidence).toBe(SINGLE_SOURCE_CAP);
    db.close();
  });

  test("an agent-relayed correction is owner tier and records its relay", async () => {
    const db = claimsDb();
    const eventId = putEvent(db);
    const result = await insertClaim(
      { db },
      claimInput(eventId, {
        producer: "agent:reviewer",
        intent: "correct",
        confidence: 1,
        events: [eventFacts(eventId, { taint: "owner" })],
      }),
    );
    expect(result.outcome).toBe("stored");
    if (result.outcome !== "stored") return;
    expect(result.claim.authority).toBe("owner_correction");
    expect(result.claim.producer).toBe("agent:reviewer");
    expect(result.claim.frontmatter["x-relayed-by"]).toBe("agent:reviewer");
    db.close();
  });
});
