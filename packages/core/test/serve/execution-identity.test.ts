import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runServeDaemon } from "../../src/serve/daemon";
import { runRail } from "../../src/serve/rails";
import { listSchedules } from "../../src/serve/schema";
import { listRunReceipts } from "../../src/serve/receipts";

test("scheduled, once and manual receipts retain distinct execution identities; brief returns to morning", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-execution-"));
  initVault(root);
  const db = openLedger(join(root, ".kizuki", "kizuki.db"));
  try {
    const manual = await runRail(db, root, "brief", { now: () => "2026-09-05T12:34:00.000Z" });
    expect(manual.execution?.trigger).toBe("manual");
    expect(listSchedules(db).find(row => row.rail === "brief")?.next_run_at).toBe("2026-09-06T07:00:00.000Z");
    await runServeDaemon(db, root, { once: true, rails: ["doctor-sweep"], http: false });
    expect(listRunReceipts(db).find(row => row.rail === "doctor-sweep")?.execution?.trigger).toBe("once");
    db.query("UPDATE schedules SET enabled=0 WHERE rail <> 'sync'").run();
    let ticks = 0;
    await runServeDaemon(db, root, { http: false, shouldContinue: () => ticks++ === 0 });
    const scheduled = listRunReceipts(db).find(row => row.rail === "sync")!;
    expect(scheduled.execution?.trigger).toBe("scheduled");
    expect(scheduled.execution?.due_at).toBeString();
    expect(scheduled.execution?.instance_id).not.toBe(manual.execution?.instance_id);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
