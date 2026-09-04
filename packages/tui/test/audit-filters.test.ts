import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, openLedger } from "@kizuki/core";
import { loadItems, PAGE_SIZE, runAudit } from "../src/app";
import type { Terminal } from "../src/terminal";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedReceipt(db: ReturnType<typeof openLedger>, index: number, writer: string, page: string): void {
  db.query(
    `INSERT INTO canon_receipts
      (receipt_id, claim_ids, provenance, sensitivity, page_path, kind, after_hash, at,
       receipt_kind, page_action, writer, producer, authority, confidence, taint,
       candidates, superseded, retrieval_ops)
     VALUES (?, '[]', '[]', 'personal', ?, 'claim', ?, ?, 'write', 'create', ?,
       'deterministic', 'connector_evidence', 0.8, 'clean', '[]', '[]', '[]')`,
  ).run(
    `receipt-${String(index).padStart(4, "0")}`,
    page,
    "a".repeat(64),
    `2026-09-03T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
    writer,
  );
}

function frameTerminal(): { terminal: Terminal; frames: string[][]; close(): void } {
  const frames: string[][] = [];
  let closed: (() => void) | null = null;
  return {
    frames,
    close: () => closed?.(),
    terminal: {
      isTTY: true,
      size: () => ({ cols: 120, rows: 30 }),
      draw: (frame) => frames.push(frame),
      onKeys: () => () => {},
      onResize: () => () => {},
      onClose: (handler) => {
        closed = () => handler("end");
        return () => {
          closed = null;
        };
      },
      enter: () => {},
      leave: () => {},
      suspend: <T>(fn: () => T) => fn(),
    },
  };
}

describe("audit command filters", () => {
  test("filter before paging keeps 201 matching receipts across reload pages", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-filters-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    for (let index = 0; index < 201; index += 1) seedReceipt(db, index, "loop", "people/grace.md");
    for (let index = 201; index < 405; index += 1) seedReceipt(db, index, "other", "people/linus.md");

    const filters = { writer: "loop", page: "people/grace.md" };
    const first = loadItems(db, vault, 0, filters);
    const second = loadItems(db, vault, PAGE_SIZE, filters);

    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.truncated).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect([...first.items, ...second.items]).toHaveLength(201);
    expect([...first.items, ...second.items].every((item) => item.receipt.writer === "loop")).toBe(true);
    expect([...first.items, ...second.items].every((item) => item.receipt.page_path === "people/grace.md")).toBe(true);
    db.close();
  });

  test("the command scope is visible and separate from local search", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-filter-frame-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = frameTerminal();
    const done = runAudit({
      db,
      vaultPath: vault,
      terminal: fake.terminal,
      filters: { writer: "loop", page: "people/grace.md" },
    });
    const frame = fake.frames.at(-1)?.join("\n") ?? "";
    expect(frame).toContain("scope");
    expect(frame).toContain("writer loop");
    expect(frame).toContain("page people/grace.md");
    fake.close();
    await done;
    db.close();
  });
});
