import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportVault, restoreVault, verifyBackup, type ExportManifest } from "../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { createVaultFts5Port, resumePurge, runPurge, verifyPurge } from "../src/ledger/purge";
import { resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../src/ledger/source-grants";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";

const AT = "2026-09-06T12:00:00.000Z";
const TABLES = ["purge_batches", "purge_batch_receipts", "purge_ops"] as const;
const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-purge-history-"));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  mkdirSync(vault, { mode: 0o700 });
  initVault(vault);
  const db = openLedger(":memory:");
  disposers.push(() => db.close());
  const event = (name: string, connector = "fixture") => {
    const result = accept(db, { ...validEvent(), source_record_id: name, connector_id: connector });
    if (result.status !== "stored") throw new Error("fixture event was not stored");
    return result.event;
  };
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  const openRestored = () => {
    const copy = openLedger(join(restored, ".kizuki", "kizuki.db"));
    disposers.push(() => copy.close());
    return copy;
  };
  return { db, vault, backup, restored, event, openRestored };
}

function history(db: Database) {
  return TABLES.map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
}

function rows(backup: string, table: typeof TABLES[number]): Record<string, unknown>[] {
  return readFileSync(join(backup, "ledger", `${table}.jsonl`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function rewriteBackup(
  backup: string,
  changes: Partial<Record<typeof TABLES[number], Record<string, unknown>[] | null>>,
  alter?: (manifest: ExportManifest) => void,
) {
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
  for (const [table, records] of Object.entries(changes)) {
    const path = `ledger/${table}.jsonl`;
    if (records === null) {
      delete manifest.files[path];
      rmSync(join(backup, path));
    } else {
      const bytes = Buffer.from(records.map(row => `${JSON.stringify(row)}\n`).join(""));
      writeFileSync(join(backup, path), bytes);
      manifest.files[path] = { count: records.length, size: bytes.length, mode: 0o600, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    }
  }
  alter?.(manifest);
  const unsigned = {
    schema: manifest.schema, vault_id: manifest.vault_id, created_at: manifest.created_at,
    schema_versions: manifest.schema_versions, snapshot: manifest.snapshot, complete: manifest.complete,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify({ ...unsigned, manifest_sha256: new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex") }, null, 2)}\n`);
  chmodSync(join(backup, "manifest.json"), 0o600);
}

describe("completed purge history backup", () => {
  test("preserves every receipt alias and separates batches sharing a time and reason", async () => {
    const f = fixture();
    f.event("atlas-one", "atlas");
    f.event("atlas-two", "atlas");
    f.event("boreal-one", "boreal");
    const first = await runPurge(f.db, f.vault, { connector_id: "atlas" }, "retire fixture", { now: () => AT });
    const second = await runPurge(f.db, f.vault, { connector_id: "boreal" }, "retire fixture", { now: () => AT });
    const before = history(f.db);
    const manifest = exportVault(f.db, f.vault, f.backup);
    expect(manifest.schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    expect(manifest.files["canon/source-survivor-lineage.v1.jsonl"]?.count).toBe(0);
    expect(TABLES.map(table => manifest.files[`ledger/${table}.jsonl`]?.count)).toEqual([2, 3, 0]);
    expect(restoreVault(f.backup, f.restored).recovery_warnings).toEqual([]);
    const copy = f.openRestored();
    expect(history(copy)).toEqual(before);
    for (const receipt of [...first.receipts, ...second.receipts]) {
      expect((await verifyPurge(copy, f.restored, receipt.receipt_id)).ok).toBe(true);
    }
  });

  test("retains completed store obligations and verifies them against the original bound store", async () => {
    const f = fixture();
    const event = f.event("atlas-one");
    const port = createVaultFts5Port(f.vault, () => AT);
    disposers.push(() => port.close());
    const result = await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture", { retrieval: port, now: () => AT });
    expect(result.purge_ops).toHaveLength(1);
    expect(result.purge_ops[0]?.state).toBe("done");
    const before = history(f.db);
    exportVault(f.db, f.vault, f.backup);
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(history(copy)).toEqual(before);
    const receiptId = result.receipts[0]!.receipt_id;
    expect((await verifyPurge(copy, f.restored, receiptId)).ok).toBe(false);
    const verified = await verifyPurge(copy, f.restored, receiptId, { retrieval: port, now: () => AT });
    expect(verified.ok).toBe(true);
    expect(verified.proofs).toHaveLength(1);
    expect(verified.proofs[0]?.store).toBe(port.descriptor.id);
  });

  test("retains a source-only batch through its actual completed source grant", async () => {
    const f = fixture();
    const source = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    f.db.query(`INSERT INTO connections
      (connector_id,source_key,config,secret_refs,connected_at,implementation_version)
      VALUES ('fixture',?,'{"schema":"kizuki.connection-config/v1","state_ref_index":null}','[]',?,'fixture@1')`).run(source, AT);
    setSourceGrant(f.db, {
      source_key: source, expected_revision: 0, operation_id: "grant-empty-fixture",
      policy: { purposes: ["capture", "export"], allowed_fields: ["text"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" },
    });
    revokeSourceGrant(f.db, { source_key: source, expected_revision: 1, operation_id: "revoke-empty-fixture" });
    const grant = await resumeSourceRevocation(f.db, f.vault, "revoke-empty-fixture", {
      ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) },
    });
    expect(grant.status).toBe("purged");
    const receiptId = grant.purge_receipt_id!;
    expect((await resumePurge(f.db, f.vault, receiptId)).ok).toBe(true);
    const before = history(f.db);
    const manifest = exportVault(f.db, f.vault, f.backup);
    expect(manifest.files["ledger/purge_batch_receipts.jsonl"]?.count).toBe(0);
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(history(copy)).toEqual(before);
    expect((await verifyPurge(copy, f.restored, receiptId)).ok).toBe(true);
  });

  test("reports older v3 purge history loss without inventing receipt membership", async () => {
    const f = fixture();
    const event = f.event("atlas");
    const result = await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture");
    exportVault(f.db, f.vault, f.backup);
    rewriteBackup(f.backup, { purge_batches: null, purge_batch_receipts: null, purge_ops: null });
    expect(verifyBackup(f.backup).schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    expect(restoreVault(f.backup, f.restored).recovery_warnings.join(" ")).toContain("no membership was inferred");
    const copy = f.openRestored();
    expect(history(copy)).toEqual([[], [], []]);
    expect(copy.query("SELECT * FROM event_purges").all()).toEqual(f.db.query("SELECT * FROM event_purges").all());
    expect((await verifyPurge(copy, f.restored, result.receipts[0]!.receipt_id)).ok).toBe(false);
  });

  test("keeps legitimate legacy orphans separate from completed current batches", async () => {
    const f = fixture();
    const event = f.event("atlas");
    const current = await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture", { now: () => AT });
    f.db.query("INSERT INTO event_purges VALUES('legacy-receipt','legacy-event','fixture','retire fixture',?)").run(AT);
    exportVault(f.db, f.vault, f.backup);
    expect(readFileSync(join(f.backup, "export-inventory.json"), "utf8")).toContain("unassigned receipts remain unverifiable");
    expect(restoreVault(f.backup, f.restored).recovery_warnings.join(" ")).toContain("store evidence");
    const copy = f.openRestored();
    expect(history(copy)).toEqual(history(f.db));
    expect((await verifyPurge(copy, f.restored, "legacy-receipt")).ok).toBe(false);
    expect((await verifyPurge(copy, f.restored, current.receipts[0]!.receipt_id)).ok).toBe(true);
  });

  test("streams a completed batch across the ordinary export page size", async () => {
    const f = fixture();
    for (let index = 0; index < 260; index++) f.event(`atlas-${index}`);
    const result = await runPurge(f.db, f.vault, { connector_id: "fixture" }, "retire fixture");
    exportVault(f.db, f.vault, f.backup);
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(history(copy)).toEqual(history(f.db));
    expect(result.receipts).toHaveLength(260);
    expect((await verifyPurge(copy, f.restored, result.receipts[259]!.receipt_id)).ok).toBe(true);
  });

  test("refuses an incomplete stored completion before callbacks or backup staging", async () => {
    const f = fixture();
    const event = f.event("atlas");
    const port = createVaultFts5Port(f.vault, () => AT);
    disposers.push(() => port.close());
    await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture", { retrieval: port, now: () => AT });
    f.db.query("UPDATE purge_ops SET proof=NULL").run();
    let notifications = 0;
    expect(() => exportVault(f.db, f.vault, f.backup, { onProgress: () => { notifications += 1; } })).toThrow("completed purge history");
    expect(notifications).toBe(0);
    expect(existsSync(f.backup)).toBe(false);
  });

  test("refuses invalid stored UTF-8 instead of changing the historical proof bytes", async () => {
    const f = fixture();
    const event = f.event("atlas");
    const port = createVaultFts5Port(f.vault, () => AT);
    disposers.push(() => port.close());
    await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture", { retrieval: port, now: () => AT });
    f.db.query("UPDATE purge_ops SET proof=CAST(? AS TEXT)").run(new Uint8Array([0xc3, 0x28]));
    expect(() => exportVault(f.db, f.vault, f.backup)).toThrow("completed purge history UTF-8");
    expect(existsSync(f.backup)).toBe(false);
  });

  for (const defect of ["partial", "duplicate member", "missing reference", "pending batch", "pending operation", "unanchored batch", "count mismatch", "old format with history", "proof scope", "proof bound"] as const) {
    test(`refuses ${defect} in completed history before installing a restore`, async () => {
      const f = fixture();
      const event = f.event("atlas");
      const port = createVaultFts5Port(f.vault, () => AT);
      disposers.push(() => port.close());
      await runPurge(f.db, f.vault, { event_id: event.event_id }, "retire fixture", { retrieval: port, now: () => AT });
      exportVault(f.db, f.vault, f.backup);
      if (defect === "partial") rewriteBackup(f.backup, { purge_ops: null });
      else if (defect === "duplicate member") {
        const members = rows(f.backup, "purge_batch_receipts");
        rewriteBackup(f.backup, { purge_batch_receipts: [...members, members[0]!] });
      } else if (defect === "missing reference") {
        rewriteBackup(f.backup, { purge_batch_receipts: rows(f.backup, "purge_batch_receipts").map(row => ({ ...row, batch_id: "unrecorded-batch" })) });
      } else if (defect === "pending batch") {
        rewriteBackup(f.backup, { purge_batches: rows(f.backup, "purge_batches").map(row => ({ ...row, state: "discovering" })) });
      } else if (defect === "pending operation") {
        rewriteBackup(f.backup, { purge_ops: rows(f.backup, "purge_ops").map(row => ({ ...row, state: "pending" })) });
      } else if (defect === "unanchored batch") {
        rewriteBackup(f.backup, { purge_batches: [...rows(f.backup, "purge_batches"), { batch_id: "unanchored", state: "ready", created_at: AT }] });
      } else if (defect === "count mismatch") {
        rewriteBackup(f.backup, {}, manifest => { manifest.files["ledger/purge_ops.jsonl"]!.count += 1; });
      } else if (defect === "old format with history") {
        rewriteBackup(f.backup, {}, manifest => { manifest.schema = "kizuki.backup/v2"; });
      } else {
        rewriteBackup(f.backup, { purge_ops: rows(f.backup, "purge_ops").map(row => {
          const proof = JSON.parse(row.proof as string);
          if (defect === "proof scope") proof.provenance.checked += 1;
          else proof.method = "fixture".repeat(10_000);
          return { ...row, proof: JSON.stringify(proof) };
        }) });
      }
      expect(() => restoreVault(f.backup, f.restored)).toThrow();
      expect(existsSync(f.restored)).toBe(false);
    });
  }
});
