import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { persistRunReceipt, pruneRunReceipts, runReceiptsPath } from "../../src/serve/receipts";
import { tryAdvisoryFileLock } from "../../src/util/advisory-file-lock";
import { DEFAULT_RAILS, emptyRunTotals } from "../../src/serve/types";
import { serializePage } from "../../src/vault/frontmatter";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function vault() {
  const path = mkdtempSync(join(tmpdir(), "doctor-cost-"));
  roots.push(path);
  initVault(path);
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

test("doctor report bytes remain identical for mixed rail and canon fixtures", () => {
  const { path, db } = vault();
  try {
    for (const [n, spec] of DEFAULT_RAILS.entries()) {
      for (let i = 0; i < 8; i++) {
        const at = `2026-09-29T00:00:${String(i).padStart(2, "0")}.000Z`;
        persistRunReceipt(db, path, { ...emptyRunTotals(), run_id: `fixture-${n}-${i}`, rail: spec.rail,
          started_at: at, finished_at: at, status: i < 2 ? "ok" : "degraded", stopped: null,
          errors: [i % 2 ? "temporary unavailable" : "retry needed"], claims_extracted: n === 0 ? 10 : 0,
          claims_written: n === 0 ? 4 : 0, canon_writes: n === 0 ? 4 : 0,
          model: { ...emptyRunTotals().model, calls: 1, model_ref: "synthetic@host.test" },
        });
      }
    }
    for (const name of ["a", "b"]) writeFileSync(join(path, "facts", `${name}.md`), serializePage({
      data: { id: "duplicate", title: "Synthetic", type: "fact", status: "active", sensitivity: "private", taint: "clean" }, body: "Neutral prose",
    }));
    writeFileSync(join(path, "facts", "c.md"), "malformed");
    const bytes = JSON.stringify(inspectServeDoctor(db, path, { now: "2026-09-30T00:00:00Z", host_checks: false, model_ref: "synthetic@host.test" }));
    const golden = join(import.meta.dir, "doctor-cost.golden.json");
    expect(bytes).toBe(readFileSync(golden, "utf8").trim());
  } finally { db.close(); }
});

test("pruning an unchanged 10 MB journal does not rewrite it", () => {
  const { path, db } = vault();
  try {
    const at = "2026-09-29T00:00:00.000Z";
    const receipt = { ...emptyRunTotals(), run_id: "synthetic-large", rail: "sync", started_at: at, finished_at: at, status: "ok", stopped: null, errors: [" ".repeat(10 * 1024 * 1024)] };
    const report = JSON.stringify(receipt);
    db.query("INSERT INTO run_receipts (run_id, rail, started_at, finished_at, status, stopped, report) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(receipt.run_id, receipt.rail, at, at, receipt.status, report);
    appendFileSync(runReceiptsPath(path), `${report}\n`);
    const before = statSync(runReceiptsPath(path));
    expect(pruneRunReceipts(db, path, "2026-09-28", 20 * 1024 * 1024)).toEqual({ deleted: 0, rewritten: 0 });
    const after = statSync(runReceiptsPath(path));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  } finally { db.close(); }
});

test("prune replays an unpublished receipt before retiring a 10 MB journal, and does not resurrect expired rows", () => {
  const { path, db } = vault();
  try {
    const receipt = { ...emptyRunTotals(), run_id: "synthetic-unpublished", rail: "fixture", started_at: "2026-09-29", finished_at: "2026-09-29", status: "ok", stopped: null };
    writeFileSync(runReceiptsPath(path), `${" ".repeat(10 * 1024 * 1024)}\n${JSON.stringify(receipt)}\n`);
    expect(pruneRunReceipts(db, path, "2026-09-28")).toEqual({ deleted: 0, rewritten: 0 });
    expect(statSync(runReceiptsPath(path)).size).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()!.n).toBe(1);
    expect(pruneRunReceipts(db, path, "2026-09-30")).toEqual({ deleted: 1, rewritten: 0 });
    expect(pruneRunReceipts(db, path, "2026-09-30")).toEqual({ deleted: 0, rewritten: 0 });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()!.n).toBe(0);
  } finally { db.close(); }
});

test("receipt publication and pruning refuse a busy publication lock", () => {
  const { path, db } = vault();
  const lock = tryAdvisoryFileLock(join(path, ".kizuki", "run-receipts.flock"));
  expect(lock).not.toBeNull();
  try {
    const receipt = { ...emptyRunTotals(), run_id: "synthetic-busy", rail: "fixture", started_at: "2026-09-29", finished_at: "2026-09-29", status: "ok" as const, stopped: null };
    expect(() => persistRunReceipt(db, path, receipt)).toThrow("journal is busy");
    expect(() => pruneRunReceipts(db, path, "2026-09-30")).toThrow("journal is busy");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()!.n).toBe(0);
  } finally { lock?.release(); db.close(); }
});

test("journal retirement refuses symlinks without changing the target", () => {
  const { path, db } = vault();
  try {
    const target = join(path, "synthetic-other-file");
    writeFileSync(target, "Neutral retained content");
    symlinkSync(target, runReceiptsPath(path));
    expect(() => pruneRunReceipts(db, path, "2026-09-30")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("Neutral retained content");
  } finally { db.close(); }
});

test("a failed range deletion retains SQL history and retry completes without replay resurrection", () => {
  const { path, db } = vault();
  try {
    persistRunReceipt(db, path, { ...emptyRunTotals(), run_id: "synthetic-rollback", rail: "fixture", started_at: "2026-09-29", finished_at: "2026-09-29", status: "ok", stopped: null });
    db.exec("CREATE TEMP TRIGGER refuse_prune BEFORE DELETE ON run_receipts BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END");
    expect(() => pruneRunReceipts(db, path, "2026-09-30")).toThrow("synthetic deletion failure");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()!.n).toBe(1);
    expect(statSync(runReceiptsPath(path)).size).toBe(0);
    db.exec("DROP TRIGGER refuse_prune");
    expect(pruneRunReceipts(db, path, "2026-09-30")).toEqual({ deleted: 1, rewritten: 0 });
  } finally { db.close(); }
});
