import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { CLAIM_SCHEMA } from "../../src/contracts/proposal";
import {
  commitClaimV2,
  readClaimRecord,
} from "../../src/claims/claim-v2-commit";
import type { ClaimV2SupportAdmission } from "../../src/claims/claim-v2-commit";
import { prepareClaimInsert } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import type { SourceReadScope } from "../../src/ledger/source-grants";
import {
  inspectSourceGrant,
  resumeSourceRevocation,
  revokeSourceGrant,
  setSourceGrant,
} from "../../src/ledger/source-grants";
import { initVault } from "../../src/vault/init";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { claimInput } from "./helpers";

/**
 * RFC 0002 invariant 3: a purge erases payload physically. `commitClaimV2` is
 * the first writer of `claim_v2_semantics` and `claim_v2_support`, and those
 * tables hold their own copy of the personal fields - subject, predicate, the
 * whole canonical object, and anchors carrying exact offsets into the source's
 * events. Support also deliberately binds events the v1 provenance does not
 * carry, so the sweep has to enumerate claims by support as well as by
 * provenance or a support-only claim would survive a purge that still reported
 * `logical_absence`.
 */

const SCOPE: SourceReadScope = { owner: true, purpose: "derive" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { dir: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "claim-v2-erasure-"));
  dirs.push(dir);
  initVault(dir);
  return { dir, db: openLedger(join(dir, ".kizuki", "kizuki.db")) };
}

function grantedSource(db: Database, connectorId = "kizuki.fixture"): string {
  const sourceKey = ulid();
  registerConnection(db, connectorId, sourceKey);
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "derive", "recall", "correction", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "personal",
    },
  });
  return sourceKey;
}

function grantedEvent(
  db: Database,
  sourceKey: string,
  connectorId = "kizuki.fixture",
): string {
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: connectorId,
      source_record_id: `rec-${crypto.randomUUID()}`,
      text: "Grace runs partnerships at Acme.",
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") {
    throw new Error(`fixture event refused: ${JSON.stringify(accepted)}`);
  }
  return accepted.event.event_id;
}

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

function support(
  db: Database,
  sourceKey: string,
  eventId: string,
): ClaimV2SupportAdmission {
  return {
    source_key: sourceKey,
    grant_revision: 1,
    events: [
      {
        event_id: eventId,
        event_content_hash: db
          .query<{ content_hash: string }, [string]>(
            "SELECT content_hash FROM events WHERE event_id = ?",
          )
          .get(eventId)!.content_hash,
      },
    ],
    anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }],
    admission: { authority: "connector_evidence", confidence: 0.5 },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

function counts(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

/** Writes a claim whose provenance is `provenanceEvent` and whose v2 support is admitted from `supportSource`. */
async function storeV2Claim(
  db: Database,
  provenanceEvent: string,
  supportSource: string,
  supportEvent: string,
): Promise<string> {
  const semantic = assertion(provenanceEvent);
  const prepared = await prepareClaimInsert({ db }, claimInput(provenanceEvent));
  return db
    .transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      commitClaimV2(db, stored.claim.claim_id, {
        semantic,
        support: support(db, supportSource, supportEvent),
        scope: SCOPE,
      });
      return stored.claim.claim_id;
    })
    .immediate();
}

test("purging a source erases the v2 semantics and support it admitted", async () => {
  const { dir, db } = setup();
  try {
    const sourceKey = grantedSource(db);
    const eventId = grantedEvent(db, sourceKey);
    const claimId = await storeV2Claim(db, eventId, sourceKey, eventId);
    expect(readClaimRecord(db, claimId)?.schema).toBe(CLAIM_V2_SCHEMA);
    expect(counts(db, "claim_v2_semantics")).toBe(1);
    expect(counts(db, "claim_v2_support")).toBe(1);
    expect(counts(db, "claim_v2_support_events")).toBe(1);

    revokeSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 1,
      operation_id: "purge-v2",
    });
    const result = await resumeSourceRevocation(db, dir, "purge-v2");
    expect(result.purge_blockers).not.toContain("claim_payload_retained");
    for (const table of [
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
    ]) {
      expect({ table, rows: counts(db, table) }).toEqual({ table, rows: 0 });
    }
    expect(readClaimRecord(db, claimId)?.schema).toBe(CLAIM_SCHEMA);
  } finally {
    db.close();
  }
});

/**
 * The support-only case the v1 provenance join cannot see: the claim's
 * provenance names the second source's event, and only `claim_v2_support` ties
 * it to the purged one.
 */
test("purging a source erases a claim reachable only through its v2 support", async () => {
  const { dir, db } = setup();
  try {
    const purged = grantedSource(db, "purged-fixture");
    const purgedEvent = grantedEvent(db, purged, "purged-fixture");
    const keeper = grantedSource(db, "keeper-fixture");
    const keeperEvent = grantedEvent(db, keeper, "keeper-fixture");
    const claimId = await storeV2Claim(db, keeperEvent, purged, purgedEvent);

    revokeSourceGrant(db, {
      source_key: purged,
      expected_revision: 1,
      operation_id: "purge-support-only",
    });
    const result = await resumeSourceRevocation(db, dir, "purge-support-only");
    expect(result.purge_blockers).not.toContain("claim_payload_retained");
    for (const table of [
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
    ]) {
      expect({ table, rows: counts(db, table) }).toEqual({ table, rows: 0 });
    }
    expect(readClaimRecord(db, claimId)?.schema).toBe(CLAIM_SCHEMA);
    expect(
      db
        .query<{ status: string; subject: string | null }, [string]>(
          "SELECT status,subject FROM claims WHERE claim_id=?",
        )
        .get(claimId),
    ).toEqual({ status: "purged", subject: null });
  } finally {
    db.close();
  }
});

test("a surviving v2 semantic or support row blocks a completed purge", async () => {
  const { dir, db } = setup();
  try {
    const sourceKey = grantedSource(db);
    const eventId = grantedEvent(db, sourceKey);
    const claimId = await storeV2Claim(db, eventId, sourceKey, eventId);
    revokeSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 1,
      operation_id: "purge-blocker",
    });
    await resumeSourceRevocation(db, dir, "purge-blocker");
    expect(
      inspectSourceGrant(db, sourceKey)?.purge_blockers,
    ).not.toContain("claim_payload_retained");

    // A support row recorded against the purged source is retained payload on
    // its own: it carries the admission record and anchor offsets.
    db.query(
      `INSERT INTO claim_v2_support
         (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      "residual-support",
      claimId,
      "[]",
      sourceKey,
      1,
      "{}",
      "2026-01-01T00:00:00.000Z",
    );
    expect(inspectSourceGrant(db, sourceKey)?.purge_blockers).toContain(
      "claim_payload_retained",
    );

    // The semantic row is reachable through that same support row, and holds
    // the subject, predicate and canonical object.
    db.query(
      `INSERT INTO claim_v2_semantics
         (claim_id, semantic_key, schema, discriminator, subject_kind, subject_id,
          predicate, object_kind, polarity, temporal_basis, valid_from, valid_to, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      claimId,
      "residual-semantic",
      CLAIM_V2_SCHEMA,
      "assertion",
      "occurrence",
      "occ-grace",
      "role.holds",
      "literal",
      "positive",
      "explicit",
      "2026-01-01T00:00:00.000Z",
      null,
      "{}",
    );
    db.query("DELETE FROM claim_v2_support WHERE support_key=?").run(
      "residual-support",
    );
    expect(inspectSourceGrant(db, sourceKey)?.purge_blockers).toContain(
      "claim_payload_retained",
    );

    // Only once both are gone does the source's payload count as absent again.
    db.query("DELETE FROM claim_v2_semantics WHERE claim_id=?").run(claimId);
    expect(inspectSourceGrant(db, sourceKey)?.purge_blockers).not.toContain(
      "claim_payload_retained",
    );
  } finally {
    db.close();
  }
});
