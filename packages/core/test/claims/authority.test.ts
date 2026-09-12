import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SINGLE_SOURCE_CAP } from "../../src/claims/authority";
import {
  resolveConflict,
  validityOverlaps,
  type ConflictClaim,
} from "../../src/claims/conflict";
import {
  getClaim,
  insertClaim,
  listClaims,
  listSupersessions,
  minTimestamp,
} from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import {
  claimInput,
  claimsDb,
  corroboratedFacts,
  eventFacts,
  putEvent,
  nativeOwnerEvent,
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

function evidenceConflict(
  overrides: Partial<ConflictClaim> &
    Pick<ConflictClaim, "claim_id" | "object" | "valid_from">,
): ConflictClaim {
  return {
    claim_key: "employment.works_at",
    polarity: "positive",
    predicate: "employment.works_at",
    authority: "connector_evidence",
    confidence: 0.8,
    valid_to: null,
    status: "live",
    provenance: ["evt"],
    ...overrides,
  };
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

    const ownerEvent = nativeOwnerEvent(db, "Grace left Acme.");
    const correction = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(ids[0], {
        provenance: [...ids, ownerEvent],
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
        provenance: [nativeOwnerEvent(db, "Grace is an analyst.")],
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
        provenance: [nativeOwnerEvent(db, "Grace is a director.")],
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

  test("connector metadata cannot mint owner authority", async () => {
    const db = claimsDb();
    const accepted = accept(db, {
      ...validEvent(),
      connector_id: "fixture",
      source_record_id: "rec-hostile-taint",
      text: "Grace runs partnerships at Acme.",
      metadata: { taint: "owner" },
    });
    expect(accepted.status).toBe("stored");
    if (accepted.status !== "stored") return;
    const { events: _ignored, ...reloaded } = claimInput(accepted.event.event_id);
    void _ignored;
    const filed = await insertClaim({ db }, reloaded);
    expect(filed.outcome).toBe("stored");
    if (filed.outcome !== "stored") return;
    expect(filed.claim.authority).toBe("model_inference");
    expect(filed.claim.confidence).toBe(SINGLE_SOURCE_CAP);
    db.close();
  });

  test("captured kizuki.owner labels cannot mint owner authority", async () => {
    const db = claimsDb();
    const accepted = accept(db, {
      ...validEvent(),
      connector_id: "kizuki.owner",
      source_record_id: "rec-owner-plain",
      text: "Grace runs partnerships at Acme.",
      metadata: {},
    });
    expect(accepted.status).toBe("stored");
    if (accepted.status !== "stored") return;
    const { events: _ignored, ...reloaded } = claimInput(
      accepted.event.event_id,
      { producer: "deterministic" },
    );
    void _ignored;
    const filed = await insertClaim({ db }, reloaded);
    expect(filed.outcome).toBe("stored");
    if (filed.outcome !== "stored") return;
    expect(filed.claim.authority).toBe("model_inference");
    db.close();
  });

  test("an agent-relayed correction is owner tier and records its relay", async () => {
    const db = claimsDb();
    const eventId = nativeOwnerEvent(db, "Grace runs partnerships at Acme.");
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

  test("minTimestamp keeps the earlier instant and treats null or empty as absent", () => {
    const zulu = "2026-02-02T23:00:00.000Z";
    const offset = "2026-02-03T01:00:00+12:00";
    expect(minTimestamp(null, offset)).toBe(offset);
    expect(minTimestamp("", offset)).toBe(offset);
    expect(minTimestamp(zulu, null)).toBe(zulu);
    expect(minTimestamp(zulu, "")).toBe(zulu);
    expect(minTimestamp(null, null)).toBeNull();
    expect(minTimestamp("", "")).toBe("");
    expect(minTimestamp(zulu, offset)).toBe(offset);
    expect(minTimestamp(offset, zulu)).toBe(offset);
    expect(zulu < offset).toBe(true);
  });

  test("validity overlap and same-tier recency compare instants, not timestamp strings", () => {
    // 2026-02-03T01:00:00+12:00 is 2026-02-02T13:00:00Z, inside the Zulu window.
    expect(
      validityOverlaps(
        { valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-02-03T00:00:00.000Z" },
        { valid_from: "2026-02-03T01:00:00+12:00", valid_to: null },
      ),
    ).toBe(true);
    // 2026-05-31T22:00:00-02:00 is 2026-06-01T00:00:00Z, adjacent, not overlapping.
    expect(
      validityOverlaps(
        { valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z" },
        { valid_from: "2026-05-31T22:00:00-02:00", valid_to: null },
      ),
    ).toBe(false);

    const live = evidenceConflict({
      claim_id: "01CLAIM000000000000000000L",
      object: "acme",
      confidence: 0.6,
      valid_from: "2026-02-03T00:00:00.000Z",
    });
    // 2026-02-02T23:00:00-02:00 is 2026-02-03T01:00:00Z: later as an instant,
    // earlier as a lexicographic string.
    const incoming = evidenceConflict({
      claim_id: "01CLAIM000000000000000000N",
      object: "northwind",
      confidence: 0.9,
      valid_from: "2026-02-02T23:00:00-02:00",
    });
    expect(resolveConflict(incoming, live)).toEqual({
      action: "supersede",
      winner: "incoming",
      rule: "R3",
    });
  });

  test("a later offset claim supersedes, and supersession plus provenance survive retry and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kizuki-claims-arb-"));
    const path = join(dir, "kizuki.db");
    let db = openLedger(path);
    try {
      const { ids, facts } = evidencePair(db);
      const live = await insertClaim(
        { db, now: () => "2026-09-02T12:00:00.000Z" },
        claimInput(ids[0], {
          claim_id: "01CLAIM000000000000000000L",
          provenance: ids,
          object: "acme",
          confidence: 0.6,
          valid_from: "2026-02-03T00:00:00.000Z",
          valid_to: "2026-12-31T00:00:00.000Z",
          events: facts,
        }),
      );
      expect(live.outcome).toBe("stored");
      if (live.outcome !== "stored") return;

      const incomingInput = claimInput(ids[0], {
        claim_id: "01CLAIM000000000000000000N",
        provenance: ids,
        body: "Grace later joined Northwind.",
        object: "northwind",
        confidence: 0.9,
        valid_from: "2026-02-02T23:00:00-02:00",
        events: facts,
      });
      const incoming = await insertClaim(
        { db, now: () => "2026-09-02T12:01:00.000Z" },
        incomingInput,
      );
      expect(incoming.outcome).toBe("stored");
      if (incoming.outcome !== "stored") return;
      expect(incoming.claim.authority).toBe("connector_evidence");
      expect(incoming.superseded).toEqual([
        { claim_id: live.claim.claim_id, rule: "R3" },
      ]);
      expect(getClaim(db, live.claim.claim_id)?.status).toBe("superseded");
      expect(getClaim(db, live.claim.claim_id)?.valid_to).toBe(
        incoming.claim.valid_from,
      );
      expect(getClaim(db, live.claim.claim_id)?.provenance).toEqual(ids);
      expect(incoming.claim.provenance).toEqual(ids);

      const retry = await insertClaim(
        { db, now: () => "2026-09-02T12:02:00.000Z" },
        incomingInput,
      );
      expect(retry.outcome).toBe("duplicate");
      expect(listSupersessions(db)).toEqual([
        {
          winner: incoming.claim.claim_id,
          loser: live.claim.claim_id,
          rule: "R3",
        },
      ]);

      db.close();
      db = openLedger(path);
      expect(getClaim(db, incoming.claim.claim_id)?.status).toBe("live");
      expect(getClaim(db, incoming.claim.claim_id)?.object).toBe("northwind");
      expect(getClaim(db, incoming.claim.claim_id)?.provenance).toEqual(ids);
      expect(getClaim(db, live.claim.claim_id)?.status).toBe("superseded");
      expect(getClaim(db, live.claim.claim_id)?.valid_to).toBe(
        "2026-02-02T23:00:00-02:00",
      );
      expect(getClaim(db, live.claim.claim_id)?.provenance).toEqual(ids);
      expect(listSupersessions(db)).toEqual([
        {
          winner: incoming.claim.claim_id,
          loser: live.claim.claim_id,
          rule: "R3",
        },
      ]);
      const reopenedRetry = await insertClaim(
        { db, now: () => "2026-09-02T12:03:00.000Z" },
        incomingInput,
      );
      expect(reopenedRetry.outcome).toBe("duplicate");
      expect(listClaims(db, { status: "live" })).toHaveLength(1);
      expect(listSupersessions(db)).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adjacent offset intervals do not supersede sequential connector evidence", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const earlier = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.6,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-06-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(earlier.outcome).toBe("stored");
    if (earlier.outcome !== "stored") return;

    const later = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        body: "Grace later joined Northwind.",
        object: "northwind",
        confidence: 0.9,
        valid_from: "2026-05-31T22:00:00-02:00",
        events: facts,
      }),
    );
    expect(later.outcome).toBe("stored");
    expect(listClaims(db, { status: "live" })).toHaveLength(2);
    expect(listSupersessions(db)).toEqual([]);
    expect(getClaim(db, earlier.claim.claim_id)?.valid_to).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    db.close();
  });

  test("owner authored outranks connector evidence and yields to owner correction", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const evidence = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.8,
        events: facts,
      }),
    );
    expect(evidence.outcome).toBe("stored");
    if (evidence.outcome !== "stored") return;
    expect(evidence.claim.authority).toBe("connector_evidence");

    const authoredEvent = nativeOwnerEvent(db, "Grace runs partnerships at Northwind.");
    const authored = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(authoredEvent, {
        provenance: [authoredEvent],
        body: "Grace runs partnerships at Northwind.",
        object: "northwind",
        producer: "owner",
        confidence: 1,
      }),
    );
    expect(authored.outcome).toBe("stored");
    if (authored.outcome !== "stored") return;
    expect(authored.claim.authority).toBe("owner_authored");
    expect(authored.superseded).toEqual([
      { claim_id: evidence.claim.claim_id, rule: "R1" },
    ]);

    const correctionEvent = nativeOwnerEvent(db, "Grace left Northwind.");
    const correction = await insertClaim(
      { db, now: () => "2026-09-02T12:02:00.000Z" },
      claimInput(correctionEvent, {
        provenance: [correctionEvent],
        body: "Grace left Northwind.",
        object: "none",
        polarity: "negative",
        producer: "owner",
        intent: "correct",
        confidence: 1,
      }),
    );
    expect(correction.outcome).toBe("stored");
    if (correction.outcome !== "stored") return;
    expect(correction.claim.authority).toBe("owner_correction");
    expect(correction.superseded[0]?.rule).toBe("R5");
    expect(listClaims(db, { status: "live" }).map((row) => row.claim_id)).toEqual([
      correction.claim.claim_id,
    ]);

    const relayEvent = nativeOwnerEvent(db, "Grace is at Contoso.");
    const relayed = await insertClaim(
      { db, now: () => "2026-09-02T12:03:00.000Z" },
      claimInput(relayEvent, {
        provenance: [relayEvent],
        body: "Grace is at Contoso.",
        object: "contoso",
        producer: "agent:reader",
        intent: "correct",
        relay_ceiling: "owner_authored",
        confidence: 1,
      }),
    );
    expect(relayed.outcome).toBe("skipped");
    if (relayed.outcome !== "skipped") return;
    expect(relayed.reason).toBe("below_authority");
    expect(relayed.claim.authority).toBe("owner_authored");
    expect(getClaim(db, correction.claim.claim_id)?.status).toBe("live");
    db.close();
  });

  test("a single untrusted conflict does not inherit corroboration from a rival reading", async () => {
    const db = claimsDb();
    const { ids, facts } = evidencePair(db);
    const live = await insertClaim(
      { db, now: () => "2026-09-02T12:00:00.000Z" },
      claimInput(ids[0], {
        provenance: ids,
        confidence: 0.8,
        events: facts,
      }),
    );
    expect(live.outcome).toBe("stored");
    if (live.outcome !== "stored") return;
    expect(live.claim.authority).toBe("connector_evidence");

    const hostile = putEvent(db, {
      connector_id: "hostile-fixture",
      source_record_id: "rec-hostile",
      text: "Grace joined Northwind.",
    });
    const incoming = await insertClaim(
      { db, now: () => "2026-09-02T12:01:00.000Z" },
      claimInput(hostile, {
        body: "Grace joined Northwind.",
        object: "northwind",
        confidence: 0.95,
        producer: "deterministic",
      }),
    );
    expect(incoming.outcome).toBe("skipped");
    if (incoming.outcome !== "skipped") return;
    expect(incoming.reason).toBe("below_authority");
    expect(incoming.claim.authority).toBe("model_inference");
    expect(incoming.claim.confidence).toBe(SINGLE_SOURCE_CAP);
    expect(listClaims(db, { status: "live" }).map((row) => row.object)).toEqual([
      "acme",
    ]);
    expect(listSupersessions(db)).toEqual([]);
    db.close();
  });
});
