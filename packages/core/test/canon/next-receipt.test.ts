import { describe, expect, test } from "bun:test";
import { openLedger } from "../../src/testing";
import { nextReceiptForPage } from "../../src/canon/receipts";

const PAGE = "people/grace.md";

function seed(
  db: ReturnType<typeof openLedger>,
  receiptId: string,
  at: string,
  overrides: { page_path?: string; reverted_by?: string | null } = {},
): void {
  db.query(
    `INSERT INTO canon_receipts
      (receipt_id, claim_ids, provenance, sensitivity, page_path, kind, after_hash, at,
       receipt_kind, page_action, writer, producer, authority, confidence, taint,
       candidates, superseded, retrieval_ops, reverted_by)
     VALUES (?, '[]', '[]', 'personal', ?, 'claim', ?, ?, 'write', 'create', 'loop',
       'deterministic', 'connector_evidence', 0.8, 'clean', '[]', '[]', '[]', ?)`,
  ).run(
    receiptId,
    overrides.page_path ?? PAGE,
    "a".repeat(64),
    at,
    overrides.reverted_by ?? null,
  );
}

describe("nextReceiptForPage", () => {
  test("returns only the immediate successor on the same page", () => {
    const db = openLedger(":memory:");
    seed(db, "receipt-0001", "2026-09-03T00:01:00.000Z");
    seed(db, "receipt-0002", "2026-09-03T00:02:00.000Z");
    seed(db, "receipt-0003", "2026-09-03T00:03:00.000Z");
    seed(db, "receipt-0004", "2026-09-03T00:02:30.000Z", { page_path: "people/linus.md" });

    const next = nextReceiptForPage(db, PAGE, {
      at: "2026-09-03T00:01:00.000Z",
      receipt_id: "receipt-0001",
    });

    expect(next?.receipt_id).toBe("receipt-0002");
    db.close();
  });

  test("breaks a timestamp tie on receipt id", () => {
    const db = openLedger(":memory:");
    seed(db, "receipt-0002", "2026-09-03T00:01:00.000Z");
    seed(db, "receipt-0001", "2026-09-03T00:01:00.000Z");
    seed(db, "receipt-0003", "2026-09-03T00:01:00.000Z");

    const next = nextReceiptForPage(db, PAGE, {
      at: "2026-09-03T00:01:00.000Z",
      receipt_id: "receipt-0001",
    });

    expect(next?.receipt_id).toBe("receipt-0002");
    db.close();
  });

  test("keeps a reverted successor, whose archive holds the earlier after-bytes", () => {
    const db = openLedger(":memory:");
    seed(db, "receipt-0001", "2026-09-03T00:01:00.000Z");
    seed(db, "receipt-0002", "2026-09-03T00:02:00.000Z", { reverted_by: "receipt-0003" });
    seed(db, "receipt-0003", "2026-09-03T00:03:00.000Z");

    const next = nextReceiptForPage(db, PAGE, {
      at: "2026-09-03T00:01:00.000Z",
      receipt_id: "receipt-0001",
    });

    expect(next?.receipt_id).toBe("receipt-0002");
    db.close();
  });

  test("returns null past the newest receipt on the page", () => {
    const db = openLedger(":memory:");
    seed(db, "receipt-0001", "2026-09-03T00:01:00.000Z");

    const next = nextReceiptForPage(db, PAGE, {
      at: "2026-09-03T00:01:00.000Z",
      receipt_id: "receipt-0001",
    });

    expect(next).toBeNull();
    db.close();
  });
});
