import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { CLAIM_V2_SCHEMA } from "../../src/contracts/claim-v2";
import { applyClaimV2Tables } from "../../src/claims/claim-v2-schema";
import { semanticKey, supportKey } from "../../src/claims/claim-v2-keys";
import {
  fromClaimV2SemanticRow,
  toClaimV2SemanticRow,
} from "../../src/claims/claim-v2-rows";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { canonicalJson } from "../../src/util/hash";
import { exportVault, restoreVault, verifyBackup } from "../../src/export";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { claimsDb, putEvent } from "./helpers";

const EVENT_ID = "01JCV2EVENTAAAAAAAAAAAAAA1";
const ABSENT_EVENT_ID = "01JCV2EVENTAAAAAAAAAAAAAA2";

function assertion(
  overrides: Partial<ClaimV2Assertion> = {},
): ClaimV2Assertion {
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
      anchors: [{ event_id: EVENT_ID, start_utf16: 0, end_utf16: 5 }],
    },
    context: [{ kind: "supplied", id: "ctx-work" }],
    polarity: "positive",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    temporal_basis: "explicit",
    anchors: [{ event_id: EVENT_ID, start_utf16: 0, end_utf16: 12 }],
    ...overrides,
  };
}

function tableSql(db: Database, name: string): string {
  const row = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  if (row === null) throw new Error(`missing table ${name}`);
  return row.sql;
}

function indexNames(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      )
      .all()
      .map((row) => row.name),
  );
}

function schemaVersion(db: Database): number {
  return db
    .query<{ version: number }, []>("SELECT version FROM schema_version")
    .get()!.version;
}

function claimsDigest(db: Database): string {
  const rows = db
    .query<Record<string, unknown>, []>(
      "SELECT * FROM claims ORDER BY claim_id",
    )
    .all();
  return canonicalJson(rows);
}

/** A v30 ledger carrying one real v1 claims row. */
function ledgerAtV30(path: string): void {
  const db = openLedger(path);
  try {
    db.exec("DROP TABLE IF EXISTS claim_v2_support_events");
    db.exec("DROP TABLE IF EXISTS claim_v2_support");
    db.exec("DROP TABLE IF EXISTS claim_v2_semantics");
    db.exec("DROP INDEX IF EXISTS claims_by_status_valid_from");
    db.query(
      `INSERT INTO claims
         (claim_id, kind, body, frontmatter, provenance, subjects, producer,
          confidence, status, created_at, body_hash, subject, predicate, object,
          polarity, claim_key, authority, sensitivity, taint, valid_from,
          asserted_at, corroboration, last_confirmed_at, content_hash)
       VALUES ('clm-v1-grace', 'claim', 'Grace leads partnerships.', '{}', '[]',
               '["occ-grace"]', 'owner', 1, 'live', '2026-01-01T00:00:00.000Z',
               'a1', 'occ-grace', 'role.holds', 'partnerships lead', 'positive',
               'k1', 'owner_correction', 'private', 'clean',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1,
               '2026-01-01T00:00:00.000Z', 'sig-v1-grace')`,
    ).run();
    db.exec("UPDATE schema_version SET version = 30");
  } finally {
    db.close();
  }
}

test("claim/v2 tables, indexes and schema version land at ledger 31", () => {
  const db = claimsDb();
  try {
    expect(LEDGER_SCHEMA_VERSION).toBe(31);
    expect(schemaVersion(db)).toBe(31);

    for (const table of [
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
    ]) {
      expect(tableSql(db, table)).toContain("STRICT");
    }
    expect(tableSql(db, "claim_v2_semantics")).toContain(
      "REFERENCES claims(claim_id)",
    );
    expect(tableSql(db, "claim_v2_support")).toContain(
      "REFERENCES claims(claim_id)",
    );
    expect(tableSql(db, "claim_v2_support_events")).toContain(
      "REFERENCES events(event_id)",
    );

    const indexes = indexNames(db);
    for (const name of [
      "claim_v2_semantics_by_subject",
      "claim_v2_support_by_claim",
      "claim_v2_support_events_by_event",
      "claims_by_status_valid_from",
    ]) {
      expect(indexes.has(name)).toBe(true);
    }
  } finally {
    db.close();
  }
});

test("a validated assertion round-trips through the row mapper byte-identically", () => {
  const value = assertion();
  const row = toClaimV2SemanticRow("clm-round-trip", value);
  expect(row.ok).toBe(true);
  if (!row.ok) throw new Error("expected a row");
  expect(row.value.payload).toBe(canonicalJson(value));
  expect(row.value.semantic_key).toBe(semanticKey(value));
  expect(row.value.subject_id).toBe("occ-grace");
  expect(row.value.predicate).toBe("role.holds");
  expect(row.value.object_kind).toBe("literal");
  expect(row.value.valid_to).toBeNull();

  const back = fromClaimV2SemanticRow(row.value);
  expect(back.ok).toBe(true);
  if (!back.ok) throw new Error("expected a semantic");
  expect(canonicalJson(back.value)).toBe(row.value.payload);

  const again = toClaimV2SemanticRow("clm-round-trip", back.value);
  expect(again.ok).toBe(true);
  if (!again.ok) throw new Error("expected a row");
  expect(again.value).toEqual(row.value);
});

test("migration 31 preserves every pre-existing claims row and re-runs as a no-op", () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-claim-v2-"));
  const path = join(directory, "ledger.db");
  try {
    ledgerAtV30(path);

    const before = new Database(path);
    let digestBefore: string;
    try {
      expect(schemaVersion(before)).toBe(30);
      digestBefore = claimsDigest(before);
    } finally {
      before.close();
    }

    const migrated = openLedger(path);
    try {
      expect(schemaVersion(migrated)).toBe(31);
      expect(claimsDigest(migrated)).toBe(digestBefore);
    } finally {
      migrated.close();
    }

    const reopened = openLedger(path);
    try {
      expect(schemaVersion(reopened)).toBe(31);
      expect(claimsDigest(reopened)).toBe(digestBefore);
      expect(() => applyClaimV2Tables(reopened)).not.toThrow();
      expect(claimsDigest(reopened)).toBe(digestBefore);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a migration that throws mid-apply leaves the ledger at 30 and a retry succeeds", () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-claim-v2-fail-"));
  const path = join(directory, "ledger.db");
  try {
    ledgerAtV30(path);

    const wedged = new Database(path);
    try {
      // An object already holding the index name makes migration 31 throw
      // after it has created its tables, standing in for any mid-apply failure.
      wedged.exec("CREATE TABLE claim_v2_semantics_by_subject (x TEXT)");
    } finally {
      wedged.close();
    }

    expect(() => openLedger(path).close()).toThrow();

    const still = new Database(path);
    try {
      expect(schemaVersion(still)).toBe(30);
      expect(
        still
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claim_v2_semantics'",
          )
          .get(),
      ).toBeNull();
      still.exec("DROP TABLE claim_v2_semantics_by_subject");
    } finally {
      still.close();
    }

    const retried = openLedger(path);
    try {
      expect(schemaVersion(retried)).toBe(31);
    } finally {
      retried.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the row mapper refuses a payload the claim/v2 validator rejects", () => {
  const withoutPredicate = { ...assertion() } as Record<string, unknown>;
  delete withoutPredicate["predicate"];
  expect(toClaimV2SemanticRow("clm-bad", withoutPredicate).ok).toBe(false);
  expect(
    toClaimV2SemanticRow("clm-bad", { schema: "kizuki.claim/v1" }).ok,
  ).toBe(false);
  expect(toClaimV2SemanticRow("clm-bad", null).ok).toBe(false);
  expect(fromClaimV2SemanticRow({ payload: "{" }).ok).toBe(false);
  expect(
    fromClaimV2SemanticRow({ payload: canonicalJson(withoutPredicate) }).ok,
  ).toBe(false);
});

test("support rows fail closed on missing claims, missing events and duplicates", () => {
  const db = claimsDb();
  try {
    const eventId = putEvent(db);
    const otherEventId = putEvent(db, { source_record_id: "rec-second" });
    db.query(
      `INSERT INTO claims
         (claim_id, kind, body, frontmatter, provenance, subjects, producer,
          confidence, status, created_at, body_hash, polarity, authority, taint,
          valid_from, asserted_at, corroboration, content_hash)
       VALUES ('clm-v2-grace', 'claim', 'Grace leads partnerships.', '{}', '[]',
               '["occ-grace"]', 'owner', 1, 'live', '2026-01-01T00:00:00.000Z', 'a2',
               'positive', 'owner_correction', 'clean', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', 1, 'sig-v2-grace')`,
    ).run();

    const semantic = assertion({
      perspective: {
        ...assertion().perspective,
        anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 5 }],
      },
      anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }],
    });
    const row = toClaimV2SemanticRow("clm-v2-grace", semantic);
    expect(row.ok).toBe(true);
    if (!row.ok) throw new Error("expected a row");
    db.query(
      `INSERT INTO claim_v2_semantics
         (claim_id, semantic_key, schema, discriminator, subject_kind, subject_id,
          predicate, object_kind, polarity, temporal_basis, valid_from, valid_to, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.value.claim_id,
      row.value.semantic_key,
      row.value.schema,
      row.value.discriminator,
      row.value.subject_kind,
      row.value.subject_id,
      row.value.predicate,
      row.value.object_kind,
      row.value.polarity,
      row.value.temporal_basis,
      row.value.valid_from,
      row.value.valid_to,
      row.value.payload,
    );

    const anchors = [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }];
    const key = supportKey({
      semantic_key: row.value.semantic_key,
      source_key: "src-fixture",
      grant_revision: 1,
      events: [{ event_id: eventId, event_content_hash: "b".repeat(64) }],
      anchors,
    });
    const insertSupport = db.query(
      `INSERT INTO claim_v2_support
         (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const args: [string, string, string, string, number, string, string] = [
      key,
      "clm-v2-grace",
      canonicalJson(anchors),
      "src-fixture",
      1,
      canonicalJson({ authority: "connector_evidence", confidence: 0.5 }),
      "2026-01-01T00:00:00.000Z",
    ];
    insertSupport.run(...args);

    // Duplicate support is one row, never a second confidence observation.
    db.query(
      `INSERT OR IGNORE INTO claim_v2_support
         (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(...args);
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claim_v2_support")
        .get(),
    ).toEqual({
      n: 1,
    });
    expect(() => insertSupport.run(...args)).toThrow();

    expect(() =>
      insertSupport.run(
        "support-orphan",
        "clm-absent",
        "[]",
        "src-fixture",
        1,
        "{}",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow();

    const insertSupportEvent = db.query(
      "INSERT INTO claim_v2_support_events (support_key, event_id, event_content_hash) VALUES (?,?,?)",
    );
    expect(() =>
      insertSupportEvent.run(key, ABSENT_EVENT_ID, "c".repeat(64)),
    ).toThrow();
    expect(() =>
      insertSupportEvent.run("support-absent", eventId, "c".repeat(64)),
    ).toThrow();
    insertSupportEvent.run(key, eventId, "b".repeat(64));
    insertSupportEvent.run(key, otherEventId, "d".repeat(64));

    // Physical event purge (RFC 0002 invariant 3) stays possible: the evidence
    // link is erased, the support row and its claim survive.
    db.query("DELETE FROM events WHERE event_id = ?").run(otherEventId);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM claim_v2_support_events",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claim_v2_support")
        .get(),
    ).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
});

test("a vault at ledger 31 backs up and restores with empty claim/v2 tables", () => {
  const vault = tempVault("kizuki-claim-v2-vault-");
  const parent = mkdtempSync(join(tmpdir(), "kizuki-claim-v2-backup-"));
  const db = openLedger(":memory:");
  try {
    const stored = accept(db, validEvent());
    expect(stored.status).toBe("stored");

    const backup = join(parent, "dump");
    const manifest = exportVault(db, vault.path, backup);
    expect(manifest.schema_versions.ledger).toBe(31);
    expect(() => verifyBackup(backup)).not.toThrow();

    const target = join(parent, "restored");
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(schemaVersion(restored)).toBe(31);
      for (const table of ["claim_v2_semantics", "claim_v2_support", "claim_v2_support_events"]) {
        expect(
          restored.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        ).toEqual({ n: 0 });
      }
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(parent, { recursive: true, force: true });
    vault.dispose();
  }
});
