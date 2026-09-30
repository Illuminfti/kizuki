import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { initVault } from "../../src/vault/init";
import { serializePage } from "../../src/vault/frontmatter";
import { emptyRunTotals } from "../../src/serve/types";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { ensureVaultId } from "../../src/serve/vault-id";

// Synthetic only. Seed outside the measured process so setup does not inflate RSS.
const [mode, path, scaleText = "1"] = process.argv.slice(2);
if (!path) throw new Error("vault path required");
if (mode === "seed") {
  const scale = Number(scaleText);
  initVault(path);
  ensureVaultId(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  chmodSync(join(path, ".kizuki", "kizuki.db"), 0o600);
  const evidence = accept(db, { ...validEvent(), text: "Neutral synthetic evidence.", subjects: [], attachments: [], metadata: {} });
  if (evidence.status !== "stored") throw new Error("synthetic evidence not stored");
  const insert = db.query("INSERT INTO run_receipts (run_id, rail, started_at, finished_at, status, stopped, report) VALUES (?, ?, ?, ?, ?, NULL, ?)");
  db.transaction(() => {
    for (let i = 0; i < 14_000 * scale; i++) {
      const at = new Date(Date.parse("2026-09-29T00:00:00Z") + i).toISOString();
      const receipt = { ...emptyRunTotals(), run_id: `synthetic-${String(i).padStart(8, "0")}`, rail: i % 2 ? "sync" : "retrieval-sweep", started_at: at, finished_at: at, status: "ok", stopped: null };
      insert.run(receipt.run_id, receipt.rail, at, at, receipt.status, JSON.stringify(receipt));
    }
  })();
  mkdirSync(join(path, "facts"), { recursive: true });
  for (let i = 0; i < 7_300 * scale; i++) {
    writeFileSync(join(path, "facts", `${String(i).padStart(8, "0")}.md`), serializePage({
      data: { id: `fact:${i}`, title: "Synthetic fact", type: "fact", status: "active", sensitivity: "private", taint: "clean", sources: [evidence.event.event_id] },
      body: "Neutral synthetic prose.\n".repeat(100),
    }));
  }
  db.close();
} else if (mode === "inspect") {
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  chmodSync(join(path, ".kizuki", "kizuki.db"), 0o600);
  const started = performance.now();
  const report = inspectServeDoctor(db, path, { now: "2026-09-30T00:00:00Z", host_checks: false });
  console.log(JSON.stringify({ wall_ms: performance.now() - started, origin: report.stores.origin, truncated: report.stores.pages_truncated }));
  db.close();
} else throw new Error("unknown fixture mode");
