import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySourceBackfill } from "../../src/serve/source-backfill-schema";
import { restoreSourceBackfillRow, SOURCE_BACKFILL_BACKUPS, sourceBackfillBackupRows, validateSourceBackfillBackup } from "../../src/serve/source-backfill-backup";
import { canonicalJson, sha256Hex } from "../../src/util/hash";

const EVENT_ID = "01J00000000000000000000000";

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE events (event_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE source_grants (source_key TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE source_event_bindings (event_id TEXT PRIMARY KEY REFERENCES events(event_id), source_key TEXT NOT NULL REFERENCES source_grants(source_key)) STRICT;
  `);
  applySourceBackfill(db);
  db.exec(`
    INSERT INTO events VALUES('${EVENT_ID}');
    INSERT INTO source_grants VALUES('source-1','active');
    INSERT INTO source_event_bindings VALUES('${EVENT_ID}','source-1');
    INSERT INTO source_backfill_attempts VALUES('operation-1','${EVENT_ID}','${"b".repeat(64)}','${"c".repeat(64)}',0,100,100,'${"a".repeat(64)}','{}','2026-10-22T00:00:00.000Z');
    INSERT INTO source_backfill_results VALUES('operation-1','settled','{}','2026-10-22T00:00:00.000Z');
  `);
  return db;
}

function backfillPlan(operation_id: string, producer_fingerprint: string, model_binding_digest: string, predecessor: unknown) {
  return {
    schema: "kizuki.source-prefix-backfill/v1", operation_id, vault_id: "synthetic-vault", event_id: EVENT_ID,
    connector_id: "fixture", source_key: "source-1", content_hash: "a".repeat(64), text_hash: "b".repeat(64),
    source_revision: 1, source_policy_digest: "c".repeat(64), source_epoch: 1, producer_fingerprint, model_binding_digest,
    window: { start_utf16: 0, end_utf16: 100, cap_utf16: 100 }, inventory_sha256: "f".repeat(64), state_sha256: "0".repeat(64),
    run_receipts: [{ run_id: "synthetic-run", sha256: "1".repeat(64) }],
    review: { compatible_prior_claims_sha256: "2".repeat(64), qualification_sha256: "3".repeat(64), producer_review_sha256: "4".repeat(64) },
    budget: { max_input_tokens: 2000, max_output_tokens: 1, input_token_overhead: 0 }, predecessor,
  };
}

function insertCompleted(db: Database, plan: ReturnType<typeof backfillPlan>) {
  const encoded = canonicalJson(plan), planSha = sha256Hex(encoded);
  const result = {
    schema: "kizuki.source-prefix-backfill-result/v1", operation_id: plan.operation_id, plan_sha256: planSha,
    outcome: "settled", usage: null, usage_known: false, claims_added: [], supports_added: 0, carried_forward: 0,
    response_sha256: null, reason: null,
  };
  db.query("INSERT INTO source_backfill_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    plan.operation_id, plan.event_id, plan.producer_fingerprint, plan.model_binding_digest, 0, 100, 100, planSha, encoded, "2026-10-22T00:00:00.000Z",
  );
  db.query("INSERT INTO source_backfill_results VALUES(?,?,?,?)").run(
    plan.operation_id, result.outcome, canonicalJson(result), "2026-10-22T00:00:00.000Z",
  );
  return result;
}

test("source-backfill schema is immutable and source purge cascades its bounded records", () => {
  const db = fixture();
  try {
    expect(db.query<{ name: string }, []>("PRAGMA table_info(source_backfill_attempts)").all().map(row => row.name)).toEqual([
      "operation_id", "event_id", "producer_fingerprint", "model_binding_digest", "start_utf16", "end_utf16", "cap_utf16", "plan_sha256", "plan", "created_at",
    ]);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(source_backfill_results)").all().map(row => row.name)).toEqual([
      "operation_id", "outcome", "report", "created_at",
    ]);
    expect(() => db.exec("UPDATE source_backfill_attempts SET cap_utf16=99")).toThrow("immutable");
    expect(() => db.exec("UPDATE source_backfill_results SET outcome='failed'")).toThrow("immutable");
    db.exec("UPDATE source_grants SET status='purged' WHERE source_key='source-1'");
    expect(db.query("SELECT * FROM source_backfill_attempts").all()).toEqual([]);
    expect(db.query("SELECT * FROM source_backfill_results").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("source-backfill backup preserves the exact attempt/result chain", () => {
  const db = fixture();
  try {
    const plan = {
      schema: "kizuki.source-prefix-backfill/v1", operation_id: "source-backfill-backup-1", vault_id: "synthetic-vault",
      event_id: EVENT_ID, connector_id: "fixture", source_key: "source-1",
      content_hash: "a".repeat(64), text_hash: "b".repeat(64), source_revision: 1, source_policy_digest: "c".repeat(64),
      source_epoch: 1, producer_fingerprint: "d".repeat(64), model_binding_digest: "e".repeat(64),
      window: { start_utf16: 0, end_utf16: 100, cap_utf16: 100 }, inventory_sha256: "f".repeat(64), state_sha256: "0".repeat(64),
      run_receipts: [{ run_id: "synthetic-run", sha256: "1".repeat(64) }],
      review: { compatible_prior_claims_sha256: "2".repeat(64), qualification_sha256: "3".repeat(64), producer_review_sha256: "4".repeat(64) },
      budget: { max_input_tokens: 2000, max_output_tokens: 1, input_token_overhead: 0 }, predecessor: null,
    };
    const encoded = canonicalJson(plan), planSha = sha256Hex(encoded);
    const result = {
      schema: "kizuki.source-prefix-backfill-result/v1", operation_id: plan.operation_id, plan_sha256: planSha,
      outcome: "settled", usage: null, usage_known: false, claims_added: [], supports_added: 0, carried_forward: 0,
      response_sha256: null, reason: null,
    };
    db.exec("DELETE FROM source_backfill_results; DELETE FROM source_backfill_attempts");
    db.query("INSERT INTO source_backfill_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      plan.operation_id, plan.event_id, plan.producer_fingerprint, plan.model_binding_digest, 0, 100, 100, planSha, encoded, "2026-10-22T00:00:00.000Z",
    );
    db.query("INSERT INTO source_backfill_results VALUES(?,?,?,?)").run(
      plan.operation_id, result.outcome, canonicalJson(result), "2026-10-22T00:00:00.000Z",
    );
    const rows = SOURCE_BACKFILL_BACKUPS.map(spec => [spec, [...sourceBackfillBackupRows(db, spec)]] as const);
    db.exec("DELETE FROM source_backfill_attempts");
    for (const [spec, records] of rows) for (const record of records) restoreSourceBackfillRow(db, spec, record);
    validateSourceBackfillBackup(db);
    expect(db.query("SELECT count(*) AS n FROM source_backfill_attempts").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM source_backfill_results").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test("source-backfill backup rejects malformed predecessor chains", () => {
  const cases = ["missing-parent", "bad-parent-hash", "branch"] as const;
  for (const kind of cases) {
    const db = fixture();
    try {
      db.exec("DELETE FROM source_backfill_results; DELETE FROM source_backfill_attempts");
      const root = backfillPlan("source-backfill-root", "d".repeat(64), "e".repeat(64), null);
      const rootResult = insertCompleted(db, root);
      const receipt = sha256Hex(canonicalJson(rootResult));
      if (kind === "missing-parent") {
        insertCompleted(db, backfillPlan("source-backfill-child", "5".repeat(64), "6".repeat(64), {
          operation_id: "missing-parent", receipt_sha256: receipt,
        }));
      } else if (kind === "bad-parent-hash") {
        insertCompleted(db, backfillPlan("source-backfill-child", "5".repeat(64), "6".repeat(64), {
          operation_id: root.operation_id, receipt_sha256: "7".repeat(64),
        }));
      } else {
        const predecessor = { operation_id: root.operation_id, receipt_sha256: receipt };
        insertCompleted(db, backfillPlan("source-backfill-child-a", "5".repeat(64), "6".repeat(64), predecessor));
        insertCompleted(db, backfillPlan("source-backfill-child-b", "8".repeat(64), "9".repeat(64), predecessor));
      }
      expect(() => validateSourceBackfillBackup(db)).toThrow("source backfill backup is invalid");
    } finally {
      db.close();
    }
  }
});
