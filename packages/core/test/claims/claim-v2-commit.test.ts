import { expect, test } from "bun:test";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { CLAIM_V2_SCHEMA } from "../../src/contracts/claim-v2";
import { CLAIM_SCHEMA } from "../../src/contracts/proposal";
import {
  commitClaimV2,
  readClaimRecord,
  readClaimV2Semantic,
} from "../../src/claims/claim-v2-commit";
import { ClaimError } from "../../src/claims/errors";
import { getClaim, prepareClaimInsert } from "../../src/claims/store";
import { canonicalJson } from "../../src/util/hash";
import { claimInput, claimsDb, putEvent } from "./helpers";

function assertion(eventId: string): ClaimV2Assertion {
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "assertion",
    subject: { kind: "occurrence", id: "occ-grace" },
    predicate: "role.holds",
    object: { kind: "literal", value: "partnerships lead" },
    perspective: {
      holder: { kind: "occurrence", id: "occ-grace" },
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 5 }],
    },
    context: [{ kind: "supplied", id: "ctx-work" }],
    polarity: "positive",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    temporal_basis: "explicit",
    anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }],
  };
}

function eventHash(db: ReturnType<typeof claimsDb>, eventId: string): string {
  return db
    .query<{ content_hash: string }, [string]>(
      "SELECT content_hash FROM events WHERE event_id = ?",
    )
    .get(eventId)!.content_hash;
}

function supportFor(
  db: ReturnType<typeof claimsDb>,
  eventId: string,
  anchors: ClaimV2Assertion["anchors"],
) {
  const event_content_hash = eventHash(db, eventId);
  return {
    source_key: "src-fixture",
    grant_revision: 1,
    events: [{ event_id: eventId, event_content_hash }],
    anchors,
    admission: { authority: "connector_evidence", confidence: 0.5 },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

test("commitClaimV2 refuses to run outside a transaction", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const stored = (
      await prepareClaimInsert({ db }, claimInput(eventId))
    );
    const applied = db.transaction(() => stored.apply()).immediate();
    expect(applied.outcome).toBe("stored");
    if (applied.outcome !== "stored") throw new Error("expected stored");
    const semantic = assertion(eventId);
    expect(() =>
      commitClaimV2(db, applied.claim.claim_id, {
        semantic,
        support: supportFor(db, eventId, semantic.anchors),
      }),
    ).toThrow("prepared claim requires a transaction");
  } finally {
    db.close();
  }
});

test("the shared writer commits v2 children in the same transaction", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const committed = db.transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      const v2 = commitClaimV2(db, stored.claim.claim_id, {
        semantic,
        support: supportFor(db, eventId, semantic.anchors),
      });
      return { stored, v2 };
    }).immediate();

    expect(committed.v2.duplicate_support).toBe(false);
    expect(readClaimV2Semantic(db, committed.stored.claim.claim_id)).toEqual(
      semantic,
    );
    const record = readClaimRecord(db, committed.stored.claim.claim_id);
    expect(record?.schema).toBe(CLAIM_V2_SCHEMA);
    if (record?.schema !== CLAIM_V2_SCHEMA) throw new Error("expected v2");
    expect(record.semantic).toEqual(semantic);
    expect(record.claim.claim_id).toBe(committed.stored.claim.claim_id);
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claim_v2_support")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM claim_v2_support_events",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test("duplicate support collides and does not add a second observation", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const claimId = db.transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      const input = {
        semantic,
        support: supportFor(db, eventId, semantic.anchors),
      };
      const first = commitClaimV2(db, stored.claim.claim_id, input);
      const second = commitClaimV2(db, stored.claim.claim_id, input);
      expect(first.duplicate_support).toBe(false);
      expect(second.duplicate_support).toBe(true);
      expect(second.support_key).toBe(first.support_key);
      return stored.claim.claim_id;
    }).immediate();
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claim_v2_support")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM claim_v2_support_events",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(readClaimRecord(db, claimId)?.schema).toBe(CLAIM_V2_SCHEMA);
  } finally {
    db.close();
  }
});

test("a rejected v2 payload rolls back the shared claims write", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic: { schema: "kizuki.claim/v1" },
          support: supportFor(db, eventId, semantic.anchors),
        });
      }).immediate(),
    ).toThrow(ClaimError);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims").get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claim_v2_semantics")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("a v1-only claim reads as the v1 discriminator", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const stored = db.transaction(() => prepared.apply()).immediate();
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(readClaimV2Semantic(db, stored.claim.claim_id)).toBeNull();
    const record = readClaimRecord(db, stored.claim.claim_id);
    expect(record).toEqual({ schema: CLAIM_SCHEMA, claim: stored.claim });
    expect(getClaim(db, stored.claim.claim_id)).toEqual(stored.claim);
    expect(readClaimRecord(db, "missing-claim")).toBeNull();
  } finally {
    db.close();
  }
});

test("support that cites a hash the ledger does not hold is refused", async () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, eventId, semantic.anchors),
            events: [
              { event_id: eventId, event_content_hash: "a".repeat(64) },
            ],
          },
        });
      }).immediate(),
    ).toThrow(/does not match the stored event/);
  } finally {
    db.close();
  }
});
