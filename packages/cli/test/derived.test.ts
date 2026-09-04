import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "@kizuki/core";
import { walkCanonReceipts } from "../src/derived";
import { createHelpers } from "./helpers";

const { cleanup, tempVault } = createHelpers();
afterEach(cleanup);

function insertReceipt(
  db: ReturnType<typeof openLedger>,
  receiptId: string,
  pagePath: string,
): void {
  db.query(
    `INSERT INTO canon_receipts (
       receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
       after_hash, at, receipt_kind, page_action, writer, producer,
       authority, confidence, taint, candidates, superseded, retrieval_ops
     ) VALUES (?, '[]', '[]', 'personal', ?, 'claim',
       'aaa', '2026-09-01T00:00:00Z', 'write', 'create', 'import',
       'deterministic', 'connector_evidence', 1.0, 'quoted', '[]', '[]', '[]')`,
  ).run(receiptId, pagePath);
}

describe("derived receipt walk", () => {
  test("pages past a single listCanonReceipts window", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      insertReceipt(db, "01WALK00000000000000000001", "facts/a.md");
      insertReceipt(db, "01WALK00000000000000000002", "facts/b.md");
      insertReceipt(db, "01WALK00000000000000000003", "facts/c.md");
      const ids = [...walkCanonReceipts(db, 1)].map((row) => row.receipt_id);
      expect(ids).toEqual([
        "01WALK00000000000000000001",
        "01WALK00000000000000000002",
        "01WALK00000000000000000003",
      ]);
    } finally {
      db.close();
    }
  });
});
