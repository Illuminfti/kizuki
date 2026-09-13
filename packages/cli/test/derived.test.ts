import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openLedger, search } from "@kizuki/core/testing";
import { initSearch } from "@kizuki/core/internal";
import {
  emptyIndexCursor,
  indexReceiptsFromCursor,
  walkCanonReceipts,
} from "../src/derived";
import { serializePage } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, tempVault } = createHelpers();
afterEach(cleanup);

function insertReceipt(
  db: ReturnType<typeof openLedger>,
  receiptId: string,
  pagePath: string,
  pageAction = "create",
): void {
  db.query(
    `INSERT INTO canon_receipts (
       receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
       after_hash, at, receipt_kind, page_action, writer, producer,
       authority, confidence, taint, candidates, superseded, retrieval_ops
     ) VALUES (?, '[]', '[]', 'personal', ?, 'claim',
       'aaa', '2026-09-01T00:00:00Z', 'write', ?, 'import',
       'deterministic', 'connector_evidence', 1.0, 'quoted', '[]', '[]', '[]')`,
  ).run(receiptId, pagePath, pageAction);
}

function seedSearchDoc(
  db: ReturnType<typeof openLedger>,
  docId: string,
  path: string,
  body: string,
): void {
  initSearch(db);
  const columns = `doc_id, scope, title, body, path, page_type, sensitivity,
       taint, authority, occurred_at, connector_id, subjects, provenance`;
  const values = [
    docId,
    "canon",
    "Gone",
    body,
    path,
    "fact",
    "personal",
    "clean",
    "connector_evidence",
    "",
    "",
    "[]",
    "[]",
  ];
  db.query(
    `INSERT INTO search_documents (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...values);
  db.query(
    `INSERT INTO search_docs (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...values);
}

function seedCanonPage(vaultPath: string, relPath: string, id: string): void {
  const path = join(vaultPath, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePage({
    data: {
      id,
      title: "Synthetic page",
      type: "fact",
      status: "active",
      sensitivity: "personal",
      taint: "clean",
      sources: [],
    },
    body: "Synthetic body.\n",
  }));
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

  test("receipt refresh with no new receipts performs no canon filesystem scan", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      insertReceipt(db, "01IDLE00000000000000000001", "facts/a.md");
      let scanned = 0;
      const result = indexReceiptsFromCursor(
        db,
        setup.vault,
        { ...emptyIndexCursor(), receipt_id: "01IDLE00000000000000000001" },
        () => {
          scanned += 1;
          return { pages: [], skipped: [], truncated: false };
        },
      );
      expect(scanned).toBe(0);
      expect(result.indexed).toBe(0);
      expect(result.cursor.receipt_id).toBe("01IDLE00000000000000000001");
      expect(result.cursor.receipts_seen).toBe(1);
    } finally {
      db.close();
    }
  });

  test("receipt refresh with new receipts scans canon once", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      insertReceipt(db, "01NEW000000000000000000001", "facts/a.md");
      insertReceipt(db, "01NEW000000000000000000002", "facts/b.md");
      insertReceipt(db, "01NEW000000000000000000003", "facts/b.md");
      let scanned = 0;
      const result = indexReceiptsFromCursor(
        db,
        setup.vault,
        { ...emptyIndexCursor(), receipt_id: "01NEW000000000000000000001" },
        () => {
          scanned += 1;
          return { pages: [], skipped: [], truncated: false };
        },
      );
      expect(scanned).toBe(1);
      expect(result.cursor.receipt_id).toBe("01NEW000000000000000000003");
      expect(result.cursor.receipts_seen).toBe(3);
    } finally {
      db.close();
    }
  });

  test("a hand-copied duplicate id withholds every stale search row", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      seedCanonPage(setup.vault, "facts/keep.md", "fact:shared");
      seedCanonPage(setup.vault, "facts/copy.md", "fact:shared");
      insertReceipt(db, "01COPY00000000000000000001", "facts/keep.md");
      db.query(
        `INSERT INTO page_index (page_id, rel_path, subject_key, last_receipt, last_hash)
         VALUES
           ('fact:shared', 'facts/keep.md', NULL, '01COPY00000000000000000001', 'aaa'),
           ('fact:old-copy', 'facts/copy.md', NULL, NULL, 'bbb')`,
      ).run();
      seedSearchDoc(db, "page:fact:shared", "facts/keep.md", "duplicateword keep");
      seedSearchDoc(db, "page:fact:old-copy", "facts/copy.md", "duplicateword copy");

      const result = indexReceiptsFromCursor(db, setup.vault, emptyIndexCursor());

      expect(result.indexed).toBe(0);
      expect(search(db, "duplicateword", { ceiling: "private" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("CLI derived indexing does not name retrieval tables", () => {
    const source = readFileSync(join(import.meta.dir, "../src/derived.ts"), "utf8");
    expect(source).not.toMatch(/\bsearch_documents\b|\bsearch_docs\b/);
    expect(source).not.toMatch(/\bremoveDoc\b|\binitSearch\b/);
  });

  test("archive receipts remove the stale search row", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      seedSearchDoc(db, "page:fact:gone", "facts/gone.md", "goneword leftover");
      expect(
        search(db, "goneword", { ceiling: "private" }).map(({ doc_id }) => doc_id),
      ).toEqual(["page:fact:gone"]);
      insertReceipt(
        db,
        "01ARCH00000000000000000001",
        "facts/gone.md",
        "archive",
      );
      const result = indexReceiptsFromCursor(db, setup.vault, emptyIndexCursor());
      expect(result.indexed).toBe(0);
      expect(
        search(db, "goneword", { ceiling: "private" }).map(({ doc_id }) => doc_id),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
