import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupVault, restoreSnapshot, verifySnapshot } from "../src/snapshot";
import { RECEIPTS_PATH } from "../src/canon/receipt-path";
import { inspectCanonRecovery } from "../src/canon/write-intent";
import { openLedger } from "../src/ledger/db";
import { doctorVault } from "../src/vault/doctor";
import { initVault } from "../src/vault/init";
import { putEvent, storeClaim, write } from "./canon/helpers";

setDefaultTimeout(240_000);
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-snapshot-"));
  const vault = join(root, "vault");
  initVault(vault);
  // The child writes at most 128 pages; each restored snapshot needs room for
  // the writability check regardless of how quickly those pages land.
  writeFileSync(join(vault, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_day = 1000\n", { mode: 0o600 });
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, vault, db };
}

function journalIds(vault: string): string[] {
  return readFileSync(join(vault, RECEIPTS_PATH), "utf8").split("\n").filter(Boolean).map(line => (JSON.parse(line) as { receipt_id: string }).receipt_id);
}

async function assertRestoresCleanly(backup: string, target: string, expectedReceipts: number): Promise<void> {
  const report = restoreSnapshot(backup, target);
  expect(report.receipts).toBe(expectedReceipts);
  expect(report.doctor.invalid).toBe(0);
  const db = openLedger(join(target, ".kizuki", "kizuki.db"));
  try {
    const rows = db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts").all().map(row => row.receipt_id).sort();
    expect(journalIds(target).sort()).toEqual(rows);
    expect(inspectCanonRecovery(db).pending).toBe(false);
    expect(doctorVault(target).counts.invalid).toBe(0);
    const event = putEvent(db, { source_record_id: "after-restore" });
    const claim = await storeClaim(db, event, { target: "people/after-restore", subject: "person:after", body: "Restored and writable.", frontmatter: { type: "person", title: "After" }, subjects: ["person:after"] });
    write({ db, vault_path: target }, claim);
    expect(existsSync(join(target, "people", "after-restore.md"))).toBe(true);
  } finally { db.close(); }
}

test("ten snapshots taken while another process writes pages each restore into a healthy, writable vault", async () => {
  const { root, vault, db } = fixture();
  const child = Bun.spawn(["bun", join(import.meta.dir, "helpers/canon-writer-child.ts"), vault], { stdout: "pipe", stderr: "inherit" });
  disposers.push(() => child.kill());
  const reader = child.stdout.getReader();
  const started = performance.now();
  for (let text = ""; !text.includes("ready");) {
    const { value, done } = await reader.read();
    if (done) throw new Error("writer exited before it was ready");
    text += new TextDecoder().decode(value);
    if (performance.now() - started > 120_000) throw new Error("writer never became ready");
  }
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    const backup = join(root, `backup-${i}`);
    const manifest = await backupVault(db, vault, backup, { wait_ms: 60_000 });
    expect(verifySnapshot(backup).manifest_sha256).toBe(manifest.manifest_sha256);
    await assertRestoresCleanly(backup, join(root, `restored-${i}`), manifest.receipts);
    seen.push(manifest.receipts);
  }
  child.kill();
  // The writer kept advancing across the snapshots, so they cut the vault at different points.
  expect(new Set(seen).size).toBeGreaterThan(1);
});

test("a snapshot refuses to overwrite a used directory and waits out a held canon writer before giving up", async () => {
  const { root, vault, db } = fixture();
  const { tryWriteFlock } = await import("../src/serve/flock");
  const lock = tryWriteFlock(vault)!;
  try {
    await expect(backupVault(db, vault, join(root, "waiting"), { wait_ms: 300 })).rejects.toThrow("writer_busy");
  } finally { lock.release(); }
  const used = join(root, "used");
  await backupVault(db, vault, used);
  await expect(backupVault(db, vault, used)).rejects.toThrow("not empty");
});
