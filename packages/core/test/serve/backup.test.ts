import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as exported from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { runRail } from "../../src/serve/rails";
import { loadBackupSelection } from "../../src/serve/config";
import { readRunReceiptsLog } from "../../src/serve/receipts";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { composeBrief } from "../../src/serve/brief";
import { worldSeed } from "../helpers/world-seed";
import { serveWorldView } from "../../src/serving/world-view";
import { worldTableSpecs } from "../../src/world/tables/registry";
import { ensureVaultId, readVaultId } from "../../src/serve/vault-id";

setDefaultTimeout(120_000);
const close: (() => void)[] = [];
afterEach(() => { for (const dispose of close.splice(0).reverse()) dispose(); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "kizuki-backup-rail-"));
  close.push(() => rmSync(parent, { recursive: true, force: true }));
  const vault = join(parent, "vault"), dir = join(parent, "backups");
  initVault(vault);
  ensureVaultId(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  close.push(() => db.close());
  const configure = (target = dir, retain = 2) => writeFileSync(join(vault, ".kizuki/serve.toml"), `[backup]\ndir=${JSON.stringify(target)}\nretain=${retain}\n`, { mode: 0o600 });
  const run = (at = "2030-01-01T00:00:00.000Z") => runRail(db, vault, "backup", { now: () => at });
  const archives = () => readdirSync(dir).filter(name => name.startsWith("kizuki-backup-")).sort();
  return { parent, vault, dir, db, configure, run, archives };
}

test("backup is off until configured and invalid owner intent is a failed receipt", async () => {
  const f = fixture();
  expect(loadBackupSelection(f.vault)).toEqual({ state: "off" });
  expect((await f.run()).status).toBe("ok");
  expect(existsSync(f.dir)).toBe(false);
  for (const config of ['[backup]\ndir="relative"', '[backup]\ndir="/tmp/example"\nretain=0', '[backup]\ndir="/tmp/example"\nretian=3']) {
    writeFileSync(join(f.vault, ".kizuki/serve.toml"), config);
    expect((await f.run()).errors).toEqual(["backup:invalid_config"]);
  }
  expect(existsSync(f.dir)).toBe(false);
});

test("a scheduled archive restores real authorized world claims with no credentials or cache streams", async () => {
  const f = fixture(), seeded = await worldSeed(f.db);
  writeFileSync(join(f.vault, ".kizuki/token.json"), 'PRIVATE_BACKUP_TOKEN_SENTINEL');
  writeFileSync(join(f.vault, ".kizuki/credentials.json"), 'PRIVATE_CREDENTIAL_SENTINEL');
  f.configure();
  const receipt = await f.run();
  expect(receipt.errors).toEqual([]);
  expect(receipt.status).toBe("ok");
  expect(receipt.model.calls).toBe(0); expect(receipt.canon_writes).toBe(0);
  expect(f.archives()).toHaveLength(1);
  const archive = join(f.dir, f.archives()[0]!);
  expect(f.archives()[0]).toContain(receipt.run_id);
  const manifest = exported.verifyBackup(archive);
  expect(manifest.vault_id).toBe(readVaultId(f.vault));
  for (const spec of worldTableSpecs().filter(row => row.class === "cache" || row.class === "derived")) {
    expect(Object.keys(manifest.files).some(path => path.includes(spec.name))).toBe(false);
  }
  const bytes = Object.keys(manifest.files).map(path => readFileSync(join(archive, path), "utf8")).join("\n");
  expect(bytes).not.toContain('PRIVATE_BACKUP_TOKEN_SENTINEL');
  expect(bytes).not.toContain('PRIVATE_CREDENTIAL_SENTINEL');
  const target = join(f.parent, "restored");
  const report = exported.restoreVault(archive, target);
  expect(report.events).toBe(1); expect(report.claims).toBe(3); expect(report.doctor.invalid).toBe(0);
  const restored = openLedger(join(target, ".kizuki/kizuki.db"));
  try {
    const result = serveWorldView({ ...seeded.ctx, db: restored, vaultPath: target }, { operation: "find_concepts", label: seeded.label, valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(JSON.stringify(result)).toContain(seeded.label);
  } finally { restored.close(); }
  expect(readdirSync(f.dir).some(name => name.startsWith(".kizuki-restore-check"))).toBe(false);
  expect(readRunReceiptsLog(f.vault).find(row => row.run_id === receipt.run_id)?.status).toBe("ok");
});

test("retention keeps only the configured count after verification and preserves unrelated directories", async () => {
  const f = fixture(); f.configure();
  expect((await f.run()).status).toBe("ok");
  mkdirSync(join(f.dir, "owner-archive"), { mode: 0o700 });
  writeFileSync(join(f.dir, "owner-archive/keep.txt"), "owner material");
  for (const day of [2, 3, 4]) expect((await f.run(`2030-01-0${day}T00:00:00.000Z`)).errors).toEqual([]);
  expect(f.archives()).toHaveLength(2);
  expect(f.archives().every(name => /2030010[34]T/.test(name))).toBe(true);
  expect(readFileSync(join(f.dir, "owner-archive/keep.txt"), "utf8")).toBe("owner material");
});

test("inside-vault and symlink destinations refuse without traversing or deleting source bytes", async () => {
  const f = fixture(); f.configure(join(f.vault, "nested"));
  expect((await f.run()).errors).toEqual(["backup:destination:inside_vault"]);
  expect(existsSync(join(f.vault, "nested"))).toBe(false);
  symlinkSync(f.vault, join(f.parent, "alias"));
  f.configure(join(f.parent, "alias/nested"));
  expect((await f.run()).errors).toEqual(["backup:destination:inside_vault"]);
  mkdirSync(f.dir, { mode: 0o700 }); symlinkSync(f.dir, join(f.parent, "outside-alias"));
  f.configure(join(f.parent, "outside-alias"));
  expect((await f.run()).errors).toEqual(["backup:destination_unsafe"]);
  expect(readdirSync(f.dir)).toEqual([]);
});

test("export consent denial is visible to doctor and brief without changing source authority", async () => {
  const f = fixture(); await worldSeed(f.db, { purposes: ["capture", "derive", "recall"] });
  const before = f.db.query("SELECT * FROM source_grants").all(); f.configure();
  const receipt = await f.run();
  expect(receipt.errors).toEqual(["backup:source:export_denied"]);
  expect(f.archives()).toEqual([]);
  expect(f.db.query("SELECT * FROM source_grants").all()).toEqual(before);
  const doctor = inspectServeDoctor(f.db, f.vault, { now: "2030-01-01T00:01:00.000Z", host_checks: false, page_walk: false });
  expect(doctor.rails.find(row => row.rail === "backup")?.last_result).toBe("failed");
  expect(composeBrief(f.db, "2030-01-01T00:01:00.000Z", null)).toContain("backup:source:export_denied");
});

test("failed restore preserves old archives and a later retry recovers", async () => {
  const f = fixture(); f.configure(undefined, 1);
  expect((await f.run()).status).toBe("ok"); const original = f.archives()[0]!;
  const broken = spyOn(exported, "restoreVault").mockImplementation(() => { throw Error("synthetic restore failure"); });
  try {
    const receipt = await f.run("2030-01-02T00:00:00.000Z");
    expect(receipt.errors).toEqual(["backup:verify_failed"]);
    expect(f.archives()).toContain(original);
    expect(readdirSync(f.dir).some(name => name.startsWith(".kizuki-restore-check"))).toBe(false);
  } finally { broken.mockRestore(); }
  expect((await f.run("2030-01-03T00:00:00.000Z")).status).toBe("ok");
  expect(f.archives()).toHaveLength(1); expect(f.archives()[0]).toContain("20300103T");
});
