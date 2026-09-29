import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitClaimV2 } from "../../src/claims/claim-v2-commit";
import type { ClaimV2SupportAdmission } from "../../src/claims/claim-v2-commit";
import { prepareClaimInsert } from "../../src/claims/store";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { runPurge, verifyPurge } from "../../src/ledger/purge";
import { setSourceGrant } from "../../src/ledger/source-grants";
import type { SourceReadScope } from "../../src/ledger/source-grants";
import { initVault } from "../../src/vault/init";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { claimInput } from "../claims/helpers";

const MARKER = "zqxtypedsupportmarker9042";
const SCOPE: SourceReadScope = { owner: true, purpose: "derive" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function grantedSource(db: Database, connectorId: string): string {
  const key = ulid();
  registerConnection(db, connectorId, key);
  setSourceGrant(db, {
    source_key: key, expected_revision: 0, operation_id: `grant-${key}`,
    policy: {
      purposes: ["capture", "derive", "recall", "correction", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
    },
  });
  return key;
}

function grantedEvent(db: Database, key: string, connectorId: string, text: string): string {
  const accepted = accept(
    db,
    { ...validEvent(), connector_id: connectorId, source_record_id: `rec-${ulid()}`, text },
    { source: { source_key: key, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") throw new Error("fixture event refused");
  return accepted.event.event_id;
}

function assertion(eventId: string): ClaimV2Assertion {
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "assertion",
    subject: { kind: "occurrence", id: "occ-grace" },
    predicate: "role.holds",
    object: { kind: "literal", value: `lead ${MARKER}` },
    perspective: {
      holder: { kind: "occurrence", id: "occ-grace" }, speaker: null, addressee: null,
      mode: "asserted", interpretation: "explicit",
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

function support(db: Database, key: string, eventId: string): ClaimV2SupportAdmission {
  return {
    source_key: key,
    grant_revision: 1,
    events: [{ event_id: eventId, event_content_hash: db.query<{ content_hash: string }, [string]>("SELECT content_hash FROM events WHERE event_id = ?").get(eventId)!.content_hash }],
    anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }],
    admission: { authority: "connector_evidence", confidence: 0.5 },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

async function typedClaim(db: Database, provenanceEvent: string, key: string, supportEvent: string): Promise<string> {
  const prepared = await prepareClaimInsert({ db }, claimInput(provenanceEvent, { body: `Grace leads it. ${MARKER}`, object: `lead ${MARKER}` }));
  return db.transaction(() => {
    const stored = prepared.apply();
    if (stored.outcome !== "stored") throw new Error("expected stored");
    commitClaimV2(db, stored.claim.claim_id, { semantic: assertion(supportEvent), support: support(db, key, supportEvent), scope: SCOPE });
    return stored.claim.claim_id;
  }).immediate();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-purge-typed-"));
  dirs.push(dir);
  initVault(dir);
  return { dir, db: openLedger(join(dir, ".kizuki", "kizuki.db")) };
}

test("a typed claim whose only evidence is the purged event is erased with its semantics and support", async () => {
  const { dir, db } = setup();
  try {
    const purgedSource = grantedSource(db, "purged-fixture");
    const purgedEvent = grantedEvent(db, purgedSource, "purged-fixture", `Grace leads it. ${MARKER}`);
    const keeperSource = grantedSource(db, "keeper-fixture");
    const keeperEvent = grantedEvent(db, keeperSource, "keeper-fixture", "An unrelated note.");
    // The claim's provenance names the surviving event; only its support binds the purged one.
    const claimId = await typedClaim(db, keeperEvent, purgedSource, purgedEvent);
    expect(db.query("SELECT count(*) AS n FROM claim_v2_semantics WHERE payload LIKE ?").get(`%${MARKER}%`)).toEqual({ n: 1 });

    const outcome = await runPurge(db, dir, { event_id: purgedEvent }, "retire", { now: () => "2026-09-02T12:00:00.000Z" });
    expect(outcome.erased.claims).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT count(*) AS n FROM claim_v2_semantics WHERE payload LIKE ?").get(`%${MARKER}%`)).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM claim_v2_support WHERE claim_id = ?").get(claimId)).toEqual({ n: 0 });
    expect(db.query<{ status: string; body: string; object: string | null }, [string]>("SELECT status, body, object FROM claims WHERE claim_id = ?").get(claimId))
      .toEqual({ status: "purged", body: "", object: null });

    const report = await verifyPurge(db, dir, outcome.receipts[0]!.receipt_id);
    expect(report.stores.find((proof) => proof.store === "claims")).toMatchObject({ found: [] });
    expect(report.ok).toBe(true);

    // A restored semantics row or anchor is caught by the claims proof.
    db.query("INSERT INTO claim_v2_support (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at) VALUES ('k', ?, '[]', ?, 1, '{}', '2026-01-01T00:00:00.000Z')").run(claimId, purgedSource);
    const dirty = await verifyPurge(db, dir, outcome.receipts[0]!.receipt_id);
    expect(dirty.stores.find((proof) => proof.store === "claims")!.found).toEqual([claimId]);
    expect(dirty.ok).toBe(false);
  } finally { db.close(); }
});

test("a typed claim that keeps other evidence stays, minus the anchors of the purged event", async () => {
  const { dir, db } = setup();
  try {
    const purgedSource = grantedSource(db, "purged-fixture");
    const purgedEvent = grantedEvent(db, purgedSource, "purged-fixture", `Grace leads it. ${MARKER}`);
    const keeperSource = grantedSource(db, "keeper-fixture");
    const keeperEvent = grantedEvent(db, keeperSource, "keeper-fixture", "An unrelated note.");
    const claimId = await typedClaim(db, keeperEvent, keeperSource, keeperEvent);
    // A second support row binds the purged event to the same claim.
    db.query("INSERT INTO claim_v2_support (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at) VALUES ('extra', ?, '[]', ?, 1, '{}', '2026-01-01T00:00:00.000Z')").run(claimId, purgedSource);
    db.query("INSERT INTO claim_v2_support_events (support_key, event_id, event_content_hash) VALUES ('extra', ?, 'h')").run(purgedEvent);

    const outcome = await runPurge(db, dir, { event_id: purgedEvent }, "retire", { now: () => "2026-09-02T12:00:00.000Z" });
    expect(db.query("SELECT count(*) AS n FROM claim_v2_support WHERE support_key = 'extra'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM claim_v2_support WHERE claim_id = ?").get(claimId)).toEqual({ n: 1 });
    expect(db.query<{ status: string }, [string]>("SELECT status FROM claims WHERE claim_id = ?").get(claimId)!.status).not.toBe("purged");
    expect((await verifyPurge(db, dir, outcome.receipts[0]!.receipt_id)).ok).toBe(true);
  } finally { db.close(); }
});
