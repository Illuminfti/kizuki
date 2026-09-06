import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, applyRevertWrite } from "../../src/canon/apply";
import { createBudgetTracker } from "../../src/canon/budget";
import { resolveTarget, type TargetDecision } from "../../src/canon/arbiter";
import { assertReceiptPaths } from "../../src/canon/paths";
import { getCanonReceipt, parseReceiptLine } from "../../src/canon/receipts";
import { undoReceipt } from "../../src/canon/undo";
import { correct } from "../../src/correction/correct";
import { grantCanonWrite, writePage } from "../../src/vault/write";
import { canonFixture, putEvent, storeClaim, write, type CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];
function fixture() { const f = canonFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });

const page = { data: {
  id: "person:sample", title: "Sample", type: "person", status: "active",
  sensitivity: "personal", taint: "clean", sources: ["event:sample"],
}, body: "Synthetic prior body.\n" };

test("selected-root capability keeps revision and deletion archives in that root", () => {
  const { vault } = fixture();
  const nested = join(vault, "projects");
  mkdirSync(join(nested, ".kizuki"), { recursive: true });
  mkdirSync(join(nested, "archive"));
  const file = join(nested, "person.md");
  const created = writePage(grantCanonWrite("loop", "create", vault), file, page);
  const prior = readFileSync(file, "utf8");
  const revised = writePage(grantCanonWrite("loop", "revise", vault), file,
    { ...page, body: "Synthetic revised body.\n" }, { revision: true, expected_hash: created.after_hash });
  expect(revised.archive_path).toBe("archive/projects__person.md--revise.md");
  expect(readFileSync(join(vault, revised.archive_path!), "utf8")).toBe(prior);
  expect(readdirSync(join(nested, "archive"))).toEqual([]);
  const removed = writePage(grantCanonWrite("revert", "remove", vault), file, page,
    { delete: true, expected_hash: revised.after_hash });
  expect(removed.archive_path).toBe("archive/projects__person.md--remove.md");
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(join(vault, removed.archive_path!), "utf8")).toContain("revised body");
  expect(readdirSync(join(nested, "archive"))).toEqual([]);
});

test("receipt paths preserve ordinary, historical archive, and erased history", async () => {
  const { db, io, vault } = fixture();
  const receipt = write(io, await storeClaim(db, putEvent(db)));
  expect(() => assertReceiptPaths(receipt)).not.toThrow();
  for (const path of ["archive/people__grace.md--receipt.md", "archive/grace.prev-20250101.md"]) {
    const historical = { ...receipt, page_path: path, archive_path: path };
    expect(parseReceiptLine(JSON.stringify(historical))).toEqual(historical);
  }
  const bytes = readFileSync(join(vault, receipt.page_path), "utf8");
  db.query("UPDATE canon_receipts SET page_path='',archive_path=NULL WHERE receipt_id=?").run(receipt.receipt_id);
  const erased = getCanonReceipt(db, receipt.receipt_id)!;
  expect(parseReceiptLine(JSON.stringify(erased))).toEqual(erased);
  await expect(undoReceipt(io, receipt.receipt_id)).rejects.toThrow("unusable page path");
  expect(readFileSync(join(vault, receipt.page_path), "utf8")).toBe(bytes);
  expect(getCanonReceipt(db, receipt.receipt_id)?.reverted_by).toBeNull();
});

test("revert captures stable input before consulting page fields", () => {
  const { io, db, vault } = fixture();
  let reads = 0;
  const input = { receipt_id: "unused", rel_path: "people/sample.md", expected_hash: null,
    get page() { reads += 1; return null; },
  };
  expect(() => applyRevertWrite(io, input)).toThrow("stable JSON data");
  expect(reads).toBe(0);
  expect(existsSync(join(vault, "people/sample.md"))).toBe(false);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()?.n).toBe(0);
});

test("ordinary writer captures its selected root once for the entire operation", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db));
  const decision = resolveTarget(f.io, claim);
  let reads = 0;
  const io = { db: f.db, get vault_path() { reads += 1; return f.vault; } };
  const receipt = applyCanonWrite(io, claim, decision, {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }),
  });
  expect(reads).toBe(1);
  expect(readFileSync(join(f.vault, receipt.page_path), "utf8")).toContain(claim.body);
  expect(getCanonReceipt(f.db, receipt.receipt_id)?.page_path).toBe(receipt.page_path);
});

test("ordinary writer refuses a non-data decision before invoking its accessors", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db));
  let reads = 0;
  const decision = { get action() { reads += 1; return "create" as const; }, rel_path: "people/grace.md" };
  expect(() => applyCanonWrite(f.io, claim, decision as TargetDecision, {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }),
  })).toThrow("stable JSON data");
  expect(reads).toBe(0);
  expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()?.n).toBe(0);
  expect(existsSync(join(f.vault, "people/grace.md"))).toBe(false);
});

test("correction keeps archived and erased receipt history inert", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db));
  const receipt = write(f.io, claim);
  const archivePath = "archive/grace.prev-20250101.md";
  const bytes = readFileSync(join(f.vault, receipt.page_path), "utf8");
  renameSync(join(f.vault, receipt.page_path), join(f.vault, archivePath));
  for (const historyPath of [archivePath, ""]) {
    f.db.query("UPDATE canon_receipts SET page_path=?,archive_path=NULL WHERE receipt_id=?")
      .run(historyPath, receipt.receipt_id);
    f.db.query("UPDATE page_index SET rel_path=?").run(historyPath);
    const preview = await correct(f.io, {
      statement: "Grace works at Initech.", target: { claim_id: claim.claim_id }, dry_run: true,
    });
    expect(preview.rewritten).toEqual([]);
    expect(preview.superseded[0]?.page_path).toBeNull();
    expect(readFileSync(join(f.vault, archivePath), "utf8")).toBe(bytes);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()?.n).toBe(1);
  }
});
