import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, lstatSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyWorldCopy, inspectWorldIntegrity } from "../../src/world/verify";
import { cardFixture } from "./card-fixture";
import { tempVault } from "../helpers/vault";
import { sha256Hex } from "../../src/util/hash";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts, pruneRunReceipts, persistRunReceipt, readRunReceiptsLog } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";
import { hardenLedgerFile } from "../../src/vault/init";
import { inspectServeDoctor } from "../../src/serve/doctor";

function snapshot(root: string): unknown {
  return readdirSync(root, { recursive: true }).sort().map((name) => {
    const path = join(root, String(name)), stat = lstatSync(path);
    return [name, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isFile() ? sha256Hex(readFileSync(path)) : "directory"];
  });
}

test("copied world probe verifies admitted provenance without changing any vault file", async () => {
  const f = await cardFixture(), copy = tempVault("world-probe-copy-");
  try {
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const file = join(copy.path, ".kizuki/kizuki.db");
    copyFileSync(join(f.ctx.vaultPath, ".kizuki/kizuki.db"), file); chmodSync(file, 0o600);
    const before = snapshot(copy.path);
    const result = verifyWorldCopy(copy.path);
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(snapshot(copy.path)).toEqual(before);
  } finally { f.dispose(); copy.dispose(); }
});

test("world verification reports damaged provenance without disclosing captured text", async () => {
  const f = await cardFixture();
  try {
    f.db.query("UPDATE events SET text=? WHERE event_id=?").run("PRIVATE-PROBE-CONTENT", f.definition.event.event_id);
    const result = inspectWorldIntegrity(f.db);
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "world_provenance")?.status).toBe("FAIL");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-PROBE-CONTENT");
  } finally { f.dispose(); }
});

test("immutable probe refuses a live WAL, journal and substituted ledger", async () => {
  const f = await cardFixture(), copy = tempVault("world-probe-refusal-");
  try {
    hardenLedgerFile(join(f.ctx.vaultPath, ".kizuki/kizuki.db"));
    expect(verifyWorldCopy(f.ctx.vaultPath)).toMatchObject({ ok: false, error: "copy_not_quiescent" });
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const file = join(copy.path, ".kizuki/kizuki.db");
    copyFileSync(join(f.ctx.vaultPath, ".kizuki/kizuki.db"), file); chmodSync(file, 0o600);
    writeFileSync(`${file}-journal`, "hot", { mode: 0o600 });
    expect(verifyWorldCopy(copy.path)).toMatchObject({ ok: false, error: "copy_not_quiescent" });
    const wrong = tempVault("world-probe-link-");
    try {
      symlinkSync(file, join(wrong.path, ".kizuki/kizuki.db"));
      expect(verifyWorldCopy(wrong.path)).toMatchObject({ ok: false, error: "custody_unavailable" });
    } finally { wrong.dispose(); }
  } finally { f.dispose(); copy.dispose(); }
});

test("weekly world verification records success and failure for doctor with result age", async () => {
  const f = await cardFixture();
  try {
    const now = "2030-01-01T00:00:00.000Z";
    const first = await runRail(f.db, f.ctx.vaultPath, "verify-world", { now: () => now });
    expect(first.status).toBe("ok");
    expect(listRunReceipts(f.db).find((row) => row.run_id === first.run_id)?.rail).toBe("verify-world");
    const doctor = inspectServeDoctor(f.db, f.ctx.vaultPath, { now: "2030-01-01T00:01:00.000Z", host_checks: false, page_walk: false });
    expect(doctor.rails.find((row) => row.rail === "verify-world")).toMatchObject({ last_result: "ok", age_s: 60, period_s: 604800 });
    f.db.query("UPDATE events SET text='tampered' WHERE event_id=?").run(f.definition.event.event_id);
    const failed = await runRail(f.db, f.ctx.vaultPath, "verify-world", { now: () => "2030-01-08T00:00:00.000Z" });
    expect(failed.status).toBe("failed");
    expect(failed.errors).toContain("world-verify:world_provenance");
    pruneRunReceipts(f.db, f.ctx.vaultPath, "2030-01-20T00:00:00.000Z", 4096);
    const later = inspectServeDoctor(f.db, f.ctx.vaultPath, { now: "2030-01-21T00:00:00.000Z", host_checks: false, page_walk: false });
    expect(later.rails.find((row) => row.rail === "verify-world")).toMatchObject({ last_result: "failed", age_s: 13 * 86400 });
    expect(listRunReceipts(f.db, { rail: "verify-world" })).toHaveLength(1);
  } finally { f.dispose(); }
});

test("retaining the last weekly verification still bounds the journal and keeps its rows equal", async () => {
  const f = await cardFixture();
  try {
    const verified = await runRail(f.db, f.ctx.vaultPath, "verify-world", { now: () => "2030-01-01T00:00:00.000Z" });
    const cap = readFileSync(join(f.ctx.vaultPath, ".kizuki/run-receipts.jsonl")).byteLength;
    for (let index = 0; index < 3; index++) persistRunReceipt(f.db, f.ctx.vaultPath, {
      ...emptyRunTotals(), run_id: `synthetic-prune-${index}`, rail: "sync", started_at: "2030-01-03T00:00:00.000Z",
      finished_at: "2030-01-03T00:00:00.000Z", status: "failed", stopped: null, errors: ["x".repeat(3000)],
    });
    pruneRunReceipts(f.db, f.ctx.vaultPath, "2030-01-02T00:00:00.000Z", cap);
    // Preserve the existing newest-in-window guarantee as well as the audit.
    // Only these two mandatory receipts may exceed an artificially tiny cap.
    expect(readFileSync(join(f.ctx.vaultPath, ".kizuki/run-receipts.jsonl")).byteLength).toBeLessThanOrEqual(cap * 2);
    const rows = listRunReceipts(f.db), log = readRunReceiptsLog(f.ctx.vaultPath);
    expect(rows.map((row) => row.run_id)).toEqual([verified.run_id, "synthetic-prune-2"]);
    expect(rows).toEqual(log);
  } finally { f.dispose(); }
});
