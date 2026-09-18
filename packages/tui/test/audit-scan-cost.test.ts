import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { loadItems, PAGE_SIZE } from "../src/app";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAGE_PATH = "people/grace.md";
const RECEIPTS_ON_PAGE = 1_200;

function seedReceipt(db: ReturnType<typeof openLedger>, index: number): void {
  db.query(
    `INSERT INTO canon_receipts
      (receipt_id, claim_ids, provenance, sensitivity, page_path, kind, after_hash, at,
       receipt_kind, page_action, writer, producer, authority, confidence, taint,
       candidates, superseded, retrieval_ops)
     VALUES (?, '[]', '[]', 'personal', ?, 'claim', ?, ?, 'write', 'create', 'loop',
       'deterministic', 'connector_evidence', 0.8, 'clean', '[]', '[]', '[]')`,
  ).run(
    `receipt-${String(index).padStart(4, "0")}`,
    PAGE_PATH,
    "a".repeat(64),
    `2026-09-03T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
  );
}

/** Counts the rows every statement materialises, so cost is measured, not timed. */
function countingLedger(db: Database): { db: Database; rows: () => number } {
  let rows = 0;
  const wrapStatement = (statement: unknown): unknown =>
    new Proxy(statement as object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const bound = value.bind(target);
        if (property === "all") {
          return (...args: unknown[]) => {
            const result = bound(...args) as unknown[];
            rows += result.length;
            return result;
          };
        }
        if (property === "get") {
          return (...args: unknown[]) => {
            const result = bound(...args);
            if (result !== null && result !== undefined) rows += 1;
            return result;
          };
        }
        return bound;
      },
    });
  const proxy = new Proxy(db as unknown as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      if (property === "query" || property === "prepare") {
        return (...args: unknown[]) => wrapStatement(bound(...args));
      }
      return bound;
    },
  });
  return { db: proxy as unknown as Database, rows: () => rows };
}

describe("audit page loading cost", () => {
  test("one audit page costs rows proportional to the page, not to the receipts on the canon page", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-scan-cost-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    for (let index = 0; index < RECEIPTS_ON_PAGE; index += 1) seedReceipt(db, index);

    const counted = countingLedger(db as unknown as Database);
    const page = loadItems(counted.db, vault, 0, { page: PAGE_PATH });

    expect(page.items).toHaveLength(PAGE_SIZE);
    // A per-item scan of the whole canon page would materialise ~240,000 rows here.
    expect(counted.rows()).toBeLessThan(4 * (PAGE_SIZE + 1));
    db.close();
  }, 30_000);
});
