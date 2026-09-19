import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import {
  commitClaimV2,
  readClaimRecord,
} from "../../src/claims/claim-v2-commit";
import { prepareClaimInsert } from "../../src/claims/store";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import type { SourceReadScope } from "../../src/ledger/source-grants";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { initVault } from "../../src/vault/init";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { claimInput } from "./helpers";

/**
 * RFC 0003 B1d: a v2 claim and its evidence chain are one durable record. A
 * backup that carried `claims` alone would restore a claim whose v2
 * discriminator silently downgrades to v1, or - worse - a durable claim with
 * an empty evidence chain, which is the state `commitClaimV2` refuses to
 * create in the first place.
 */

const SCOPE: SourceReadScope = { owner: true, purpose: "derive" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
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

function rows(db: Database, table: string): Record<string, unknown>[] {
  const order = table === "claim_v2_semantics" ? "claim_id" : "support_key, rowid";
  return db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
}

async function populated(): Promise<{ db: Database; vault: string; claimId: string }> {
  const vault = temporary("claim-v2-backup-vault-");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const sourceKey = ulid();
  registerConnection(db, "kizuki.fixture", sourceKey);
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "derive", "recall", "correction", "session", "export"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "personal",
    },
  });
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: "kizuki.fixture",
      source_record_id: `rec-${crypto.randomUUID()}`,
      text: "Grace runs partnerships at Acme.",
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (accepted.status !== "stored") {
    throw new Error(`fixture event refused: ${JSON.stringify(accepted)}`);
  }
  const eventId = accepted.event.event_id;
  const semantic = assertion(eventId);
  const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
  const claimId = db
    .transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      commitClaimV2(db, stored.claim.claim_id, {
        semantic,
        support: {
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
        },
        scope: SCOPE,
      });
      return stored.claim.claim_id;
    })
    .immediate();
  return { db, vault, claimId };
}

test("a backup carries a v2 claim's semantics and evidence chain and restores them", async () => {
  const { db, vault, claimId } = await populated();
  const before = {
    semantics: rows(db, "claim_v2_semantics"),
    support: rows(db, "claim_v2_support"),
    supportEvents: rows(db, "claim_v2_support_events"),
  };
  expect(before.semantics).toHaveLength(1);
  expect(before.support).toHaveLength(1);
  expect(before.supportEvents).toHaveLength(1);

  const backup = join(temporary("claim-v2-backup-out-"), "backup");
  const manifest = exportVault(db, vault, backup);
  db.close();

  for (const file of [
    "claims/claim_v2_semantics.jsonl",
    "claims/claim_v2_support.jsonl",
    "claims/claim_v2_support_events.jsonl",
  ]) {
    expect({ file, count: manifest.files[file]?.count }).toEqual({ file, count: 1 });
    expect(existsSync(join(backup, file))).toBe(true);
  }
  // The admission and the anchors travel as the stored canonical text.
  const supportLine = JSON.parse(
    readFileSync(join(backup, "claims/claim_v2_support.jsonl"), "utf8").trim(),
  ) as Record<string, unknown>;
  expect(supportLine.admission).toBe(before.support[0]!.admission);
  expect(supportLine.anchors).toBe(before.support[0]!.anchors);

  const target = join(temporary("claim-v2-restore-parent-"), "vault");
  restoreVault(backup, target);
  const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
  try {
    expect(rows(restored, "claim_v2_semantics")).toEqual(before.semantics);
    expect(rows(restored, "claim_v2_support")).toEqual(before.support);
    expect(rows(restored, "claim_v2_support_events")).toEqual(before.supportEvents);
    const record = readClaimRecord(restored, claimId);
    expect(record?.schema).toBe(CLAIM_V2_SCHEMA);
    expect(record !== null && record.schema === CLAIM_V2_SCHEMA ? record.semantic : null)
      .toEqual(before.semantics[0]!.payload === undefined ? null : JSON.parse(
        before.semantics[0]!.payload as string,
      ) as ClaimV2Assertion);
  } finally {
    restored.close();
  }
});
