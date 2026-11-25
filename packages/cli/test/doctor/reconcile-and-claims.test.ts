import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../../core/src/ledger/db";
import { putEvent } from "../../../core/test/claims/helpers";
import { createHelpers } from "../helpers";

setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor batch receipt reconciliation reports orphan rows, orphan receipts, duplicates, and torn/invalid lines", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const evId = putEvent(db);
  const hash = "a".repeat(64);
  try {
    const insertReceipt = db.prepare(
      `INSERT INTO canon_receipts (
         receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
         before_hash, after_hash, at, receipt_kind, page_action, archive_path,
         writer, producer, model_ref, authority, confidence, taint,
         candidates, superseded, retrieval_ops, reverts, reverted_by
       ) VALUES (?, '[]', ?, 'personal', 'facts/p.md', 'write', NULL, ?,
         '2026-10-01T00:00:00.000Z', 'write', 'create', NULL, 'loop', 'model',
         NULL, 'model_inference', 0.7, 'clean', '[]', '[]', '[]', NULL, NULL)`,
    );
    insertReceipt.run("01JRCPTOK00000000000000001", JSON.stringify([evId]), hash);
    insertReceipt.run("01JRCPTDBONLY0000000000002", JSON.stringify([evId]), hash);
  } finally {
    db.close();
  }

  writeFileSync(
    join(setup.vault, ".kizuki", "receipts", "promotions.jsonl"),
    [
      JSON.stringify({ receipt_id: "01JRCPTOK00000000000000001" }),
      JSON.stringify({ receipt_id: "01JRCPTOK00000000000000001" }),
      JSON.stringify({ receipt_id: "01JRCPTJSONONLY00000000003" }),
      "{torn json",
      JSON.stringify({ no_receipt_id: true }),
      JSON.stringify({ receipt_id: "" }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  const result = runCli(setup.env, "doctor", "--json");
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout) as {
    data: { receipts: number; orphans: string[] };
  };
  expect(report.data.receipts).toBe(2);
  expect(report.data.orphans).toEqual([
    "duplicate receipt 01JRCPTOK00000000000000001",
    "orphan receipt 01JRCPTJSONONLY00000000003 (no canon_receipts row)",
    "torn JSONL line 4",
    "invalid JSONL line 5",
    "invalid JSONL line 6",
    "orphan row 01JRCPTDBONLY0000000000002 (no JSONL line)",
  ]);
});

test("doctor single-pass claim summary counts statuses, producers, written/unwritten, and filters capture fanout from filed_claims", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const evId = putEvent(db);
  const now = "2026-10-01T00:00:00.000Z";
  try {
    const insertClaim = db.prepare(
      `INSERT INTO claims (
         claim_id, kind, target, body, frontmatter, provenance, subjects,
         producer, confidence, status, created_at, body_hash, subject,
         predicate, object, polarity, claim_key, authority, sensitivity, taint,
         model_ref, valid_from, valid_to, asserted_at, retracted_at,
         superseded_by, receipt_id, corroboration, last_confirmed_at
       ) VALUES (?, 'claim', ?, 'body', ?, ?, '[]', ?, 0.8, ?, ?, ?, 'subj',
         'fact', 'val', 'positive', ?, 'model_inference', 'personal', 'clean',
         NULL, ?, NULL, ?, NULL, NULL, ?, 1, ?)`,
    );
    const prov = JSON.stringify([evId]);
    const h = (n: number) => n.toString(16).padStart(64, "0");
    // Live written (model)
    insertClaim.run("01JCLM00000000000000000001", "facts/a", "{}", prov, "model", "live", now, h(1), "k1", now, now, "01JR1", now);
    // Live unwritten (owner)
    insertClaim.run("01JCLM00000000000000000002", "facts/b", "{}", prov, "owner", "live", now, h(2), "k2", now, now, null, now);
    // Live unwritten (agent:bot)
    insertClaim.run("01JCLM00000000000000000003", "facts/c", "{}", prov, "agent:bot", "live", now, h(3), "k3", now, now, null, now);
    // Live unwritten (deterministic, NOT capture fanout)
    insertClaim.run("01JCLM00000000000000000004", "facts/d", "{}", prov, "deterministic", "live", now, h(4), "k4", now, now, null, now);
    // Live capture fanout pending (excluded from unwritten)
    insertClaim.run(
      "01JCLM00000000000000000005",
      "captures/chat/2026-10-01",
      JSON.stringify({ type: "source", "x-capture-kind": "message" }),
      prov,
      "deterministic",
      "live",
      now,
      h(5),
      "k5",
      now,
      now,
      null,
      now,
    );
    // Skipped capture fanout (excluded from filed_claims)
    insertClaim.run(
      "01JCLM00000000000000000006",
      "captures/chat/2026-10-01",
      JSON.stringify({ "x-skip-reason": "message_capture_fanout" }),
      prov,
      "deterministic",
      "skipped",
      now,
      h(6),
      "k6",
      now,
      now,
      null,
      now,
    );
    // Skipped ordinary claim (included in filed_claims)
    insertClaim.run("01JCLM00000000000000000007", "facts/e", "{}", prov, "model", "skipped", now, h(7), "k7", now, now, null, now);
    // Superseded + purged
    insertClaim.run("01JCLM00000000000000000008", "facts/f", "{}", prov, "model", "superseded", now, h(8), "k8", now, now, null, now);
    insertClaim.run("01JCLM00000000000000000009", "facts/g", "{}", prov, "model", "purged", now, h(9), "k9", now, now, null, now);
  } finally {
    db.close();
  }

  const result = runCli(setup.env, "doctor", "--json");
  const report = JSON.parse(result.stdout) as {
    data: {
      claims: {
        live: number;
        filed: number;
        written: number;
        unwritten: number;
        superseded: number;
        skipped: number;
        purged: number;
        capture_fanout: { pending: number; skipped: number };
        by_producer: { model: number; deterministic: number; owner: number; agent: number };
      };
      live_claims: { claim_id: string }[];
      filed_claims: { claim_id: string }[];
    };
  };
  expect(report.data.claims).toMatchObject({
    live: 5,
    filed: 2,
    written: 1,
    unwritten: 3,
    superseded: 1,
    skipped: 2,
    purged: 1,
    capture_fanout: { pending: 1, skipped: 1 },
    by_producer: { model: 1, deterministic: 2, owner: 1, agent: 1 },
  });
  expect(report.data.live_claims).toHaveLength(5);
  expect(report.data.filed_claims.map((c) => c.claim_id)).toEqual([
    "01JCLM00000000000000000007",
  ]);
});
