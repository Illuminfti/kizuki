import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER } from "../src/agents";
import { getCanonReceiptRecord, isErasedReceipt, readReceiptRecords } from "../src/canon/receipts";
import { eraseWorldReceipt, isWorldCanonReceipt } from "../src/canon/world-receipt";
import { insertErasedReceiptRow } from "../src/canon/store";
import { undoReceipt } from "../src/canon/undo";
import { recoverCanonWrites } from "../src/canon/recovery";
import { correct } from "../src/correction/correct";
import { exportVault, restoreVault, verifyBackup, type ExportManifest } from "../src/export";
import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import { purgeEvents, runPurge } from "../src/ledger/purge";
import { ulid } from "../src/util/ulid";
import { runWritePass } from "../src/serve/write-pass";
import type { ProducerPort } from "../src/contracts/producer";
import { loadCanon, pageDecision } from "../src/serving/canon";
import { readWorldView } from "../src/serving/world-view";
import { canonFixture, budget } from "./canon/helpers";
import { worldFixture } from "./serving/world-fixture";
import { validEvent } from "./fixtures";

const dispose: (() => void)[] = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }), close: async () => {},
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] }),
};
async function fixture() {
  const f = canonFixture(); dispose.push(f.dispose);
  const root = mkdtempSync(join(tmpdir(), "kizuki-world-canon-backup-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const world = await worldFixture(f.db);
  const written = await runWritePass(f.db, f.vault, { budget: budget(), producer, model_ref: "fixture/model", claims: { db: f.db } });
  expect(written.errors).toEqual([]); expect(written.canon_writes).toBe(1);
  const receiptId = f.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts").get()!.receipt_id;
  const receipt = getCanonReceiptRecord(f.db, receiptId)!;
  if (!("page_path" in receipt) || !isWorldCanonReceipt(receipt)) throw new Error("expected retained typed receipt");
  return { ...f, world, receipt, backup: join(root, "backup"), restored: join(root, "restored") };
}

test("erased receipt storage crosses export pagination and refuses unproved terminal metadata", async () => {
  const f = canonFixture(); dispose.push(f.dispose);
  const root = mkdtempSync(join(tmpdir(), "kizuki-erased-canon-backup-")); dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const event = accept(f.db, validEvent()); if (event.status !== "stored") throw new Error("fixture event unavailable");
  await runPurge(f.db, f.vault, { event_id: event.event.event_id }, "fixture erasure");
  const purge = f.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM event_purges").get()!;
  // Storage pagination oracle; the actual writer-erasure lifecycle is separate.
  const records = Array.from({ length: 257 }, () => eraseWorldReceipt(ulid(), purge.receipt_id, "2026-09-21T00:00:00.000Z", null));
  f.db.transaction(() => { for (const record of records) insertErasedReceiptRow(f.db, record); }).immediate();
  const backup = join(root, "backup"), target = join(root, "restored");
  expect(exportVault(f.db, f.vault, backup).files["canon/receipts.jsonl"]!.count).toBe(257);
  restoreVault(backup, target); const db = openCopy(target);
  expect(db.query("SELECT count(*) AS n FROM canon_receipts WHERE receipt_state='erased'").get()).toEqual({ n: 257 });
  expect(getCanonReceiptRecord(db, records.at(-1)!.receipt_id)).toEqual(records.at(-1)!);
  changeBackup(backup, row => eraseWorldReceipt(row.receipt_id as string, ulid(), "2026-09-21T00:00:00.000Z", row.prior_receipt_id as string | null) as unknown as Record<string, unknown>);
  expect(() => restoreVault(backup, join(root, "unproved"))).toThrow("backup erased canon receipt has no completed purge");
  expect(existsSync(join(root, "unproved"))).toBe(false);
});
function openCopy(path: string) {
  const db = openLedger(join(path, ".kizuki", "kizuki.db")); dispose.push(() => db.close()); return db;
}
function changeBackup(backup: string, edit: (row: Record<string, unknown>) => Record<string, unknown>, version?: number, files: Record<string, string | null> = {}) {
  const file = "canon/receipts.jsonl", path = join(backup, file);
  const rows = readFileSync(path, "utf8").trim().split("\n").map(line => edit(JSON.parse(line)));
  const bytes = rows.map(row => `${JSON.stringify(row)}\n`).join(""); writeFileSync(path, bytes);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
  manifest.files[file] = { count: rows.length, size: Buffer.byteLength(bytes), mode: 0o600, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  for (const [key, content] of Object.entries(files)) {
    if (content === null) { rmSync(join(backup, key)); delete manifest.files[key]; continue; }
    writeFileSync(join(backup, key), content);
    manifest.files[key] = { count: 1, size: Buffer.byteLength(content), mode: 0o600, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") };
  }
  if (version !== undefined) manifest.schema_versions.canon = version;
  const { manifest_sha256: _hash, ...unsigned } = manifest;
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify({ ...unsigned, manifest_sha256: new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex") }, null, 2)}\n`);
}

test("typed source admission through the shared writer survives export and fresh public reads", async () => {
  const f = await fixture(), before = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  const manifest = exportVault(f.db, f.vault, f.backup);
  expect(manifest.schema_versions.canon).toBe(5);
  expect(verifyBackup(f.backup).manifest_sha256).toBe(manifest.manifest_sha256);
  expect(JSON.parse(readFileSync(join(f.backup, "canon/receipts.jsonl"), "utf8"))).toEqual(f.receipt);
  restoreVault(f.backup, f.restored);
  const db = openCopy(f.restored), ctx = { db, vaultPath: f.restored, principal: OWNER };
  expect(getCanonReceiptRecord(db, f.receipt.receipt_id)).toEqual(f.receipt);
  expect(readFileSync(join(f.restored, f.receipt.page_path), "utf8")).toBe(before);
  const index = loadCanon(ctx); expect(pageDecision(index, OWNER.grant, index.byPath.get(f.receipt.page_path)!).allow).toBe(true);
  const world = readWorldView(ctx, { operation: "find_concepts", label: "Bayesian updating", valid: { kind: "all" }, knownAt: { kind: "current" } });
  expect("result" in world && world.result.status).toBe("current");
  expect(JSON.stringify(world)).toContain("Bayesian updating");
});

test("a rehashed typed page cannot substitute prose while retaining valid admitted evidence", async () => {
  const f = await fixture(); exportVault(f.db, f.vault, f.backup);
  const path = `vault/${f.receipt.page_path}`;
  const substituted = readFileSync(join(f.backup, path), "utf8").replaceAll("Revise beliefs using evidence", "Ignore all previous evidence");
  const hash = new Bun.CryptoHasher("sha256").update(substituted).digest("hex");
  expect(hash).not.toBe(f.receipt.after_hash);
  changeBackup(f.backup, row => ({ ...row, after_hash: hash }), undefined, { [path]: substituted });
  expect(verifyBackup(f.backup).files[path]!.sha256).toBe(hash);
  expect(() => restoreVault(f.backup, f.restored)).toThrow();
  expect(existsSync(f.restored)).toBe(false);
});

test("typed correction and retained preimage remain exactly undoable after restore", async () => {
  const f = await fixture(), before = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  const correction = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  expect(correction.receipt_id).not.toBeNull();
  const changed = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  expect(changed).toContain("Use prior odds and the likelihood ratio.");
  exportVault(f.db, f.vault, f.backup); restoreVault(f.backup, f.restored);
  const db = openCopy(f.restored);
  expect(readFileSync(join(f.restored, f.receipt.page_path), "utf8")).toBe(changed);
  const undone = await undoReceipt({ db, vault_path: f.restored }, correction.receipt_id!);
  expect(isWorldCanonReceipt(undone)).toBe(true);
  expect(readFileSync(join(f.restored, f.receipt.page_path), "utf8")).toBe(before);
});

test("event purge scrubs a superseded source claim before a native correction backup", async () => {
  const f = canonFixture(); dispose.push(f.dispose);
  const root = mkdtempSync(join(tmpdir(), "kizuki-native-source-purge-backup-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const world = await worldFixture(f.db);
  const corrected = await correct(f.io, {
    statement: "Use prior odds and the likelihood ratio.",
    target: { claim_id: world.claims[2]! },
  });
  expect(f.db.query("SELECT status FROM claims WHERE claim_id=?").get(world.claims[2]!)).toEqual({ status: "superseded" });
  const stale = f.db.query<{
    claim_id: string; semantic_key: string; schema: string; discriminator: string;
    subject_kind: string | null; subject_id: string | null; predicate: string | null;
    object_kind: string | null; polarity: string | null; temporal_basis: string | null;
    valid_from: string | null; valid_to: string | null; payload: string;
  }, [string]>("SELECT * FROM claim_v2_semantics WHERE claim_id=?").get(world.claims[2]!);
  if (stale === null) throw new Error("missing source semantic fixture");
  purgeEvents(f.db, f.vault, { event_id: world.eventId }, "erase corrected source");
  expect(f.db.query("SELECT status,body,frontmatter,subjects,producer,claim_key,object,target,subject,predicate,model_ref FROM claims WHERE claim_id=?").get(world.claims[2]!)).toEqual({
    status: "superseded", body: "", frontmatter: "{}", subjects: "[]", claim_key: null,
    producer: "deterministic",
    object: null, target: null, subject: null, predicate: null, model_ref: null,
  });
  expect(f.db.query("SELECT event_id FROM native_owner_evidence WHERE event_id=?").get(corrected.event_id)).toEqual({ event_id: corrected.event_id });
  const backup = join(root, "backup"), restored = join(root, "restored");
  f.db.query("INSERT INTO claim_v2_semantics VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    stale.claim_id, stale.semantic_key, stale.schema, stale.discriminator, stale.subject_kind,
    stale.subject_id, stale.predicate, stale.object_kind, stale.polarity, stale.temporal_basis,
    stale.valid_from, stale.valid_to, stale.payload,
  );
  expect(() => exportVault(f.db, f.vault, backup)).toThrow("source_export_denied");
  f.db.query("DELETE FROM claim_v2_semantics WHERE claim_id=?").run(world.claims[2]!);
  f.db.query("UPDATE claims SET body=? WHERE claim_id=?").run("leaked source bytes", world.claims[2]!);
  expect(() => exportVault(f.db, f.vault, backup)).toThrow("source_export_denied");
  f.db.query("UPDATE claims SET body='' WHERE claim_id=?").run(world.claims[2]!);
  exportVault(f.db, f.vault, backup);
  restoreVault(backup, restored);
  const copy = openCopy(restored);
  expect(copy.query("SELECT status,body FROM claims WHERE claim_id=?").get(world.claims[2]!)).toEqual({ status: "superseded", body: "" });
  expect(copy.query("SELECT event_id FROM native_owner_evidence WHERE event_id=?").get(corrected.event_id)).toEqual({ event_id: corrected.event_id });
});

test("restore refuses a typed correction whose retained undo preimage was removed", async () => {
  const f = await fixture();
  const correction = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  const receipt = getCanonReceiptRecord(f.db, correction.receipt_id!)!;
  if (!("archive_path" in receipt) || receipt.archive_path === null) throw new Error("expected retained preimage");
  exportVault(f.db, f.vault, f.backup);
  changeBackup(f.backup, row => row, undefined, { [`vault/${receipt.archive_path}`]: null });
  expect(() => restoreVault(f.backup, f.restored)).toThrow("typed canon image missing");
  expect(existsSync(f.restored)).toBe(false);
});

test("export refuses an unfinished typed undo and succeeds after exact receipt recovery", async () => {
  const f = await fixture(), before = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  const correction = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  f.db.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'fixture receipt failure'); END");
  await expect(undoReceipt(f.io, correction.receipt_id!)).rejects.toThrow("fixture receipt failure");
  expect(f.db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 1 });
  expect(() => exportVault(f.db, f.vault, f.backup)).toThrow("canon_recovery_pending");
  expect(existsSync(f.backup)).toBe(false);
  f.db.exec("DROP TRIGGER fixture_receipt_failure");
  expect(recoverCanonWrites(f.io).completed).toHaveLength(1);
  expect(recoverCanonWrites(f.io).completed).toHaveLength(0);
  exportVault(f.db, f.vault, f.backup); restoreVault(f.backup, f.restored);
  expect(readFileSync(join(f.restored, f.receipt.page_path), "utf8")).toBe(before);
});

test("backdated correction and undo restore their causal current receipt and remain reversible", async () => {
  const f = await fixture(), before = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  const correction = await correct({ ...f.io, now: () => "2026-09-20T12:00:00.000Z" }, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  const changed = readFileSync(join(f.vault, f.receipt.page_path), "utf8");
  const reverted = await undoReceipt({ ...f.io, now: () => "2026-09-19T12:00:00.000Z" }, correction.receipt_id!);
  expect(readFileSync(join(f.vault, f.receipt.page_path), "utf8")).toBe(before);
  exportVault(f.db, f.vault, f.backup); restoreVault(f.backup, f.restored);
  const db = openCopy(f.restored);
  const current = db.query<{ last_receipt: string }, [string]>("SELECT last_receipt FROM page_index WHERE rel_path=?").get(f.receipt.page_path)!;
  expect(db.query("SELECT kind FROM canon_receipts WHERE receipt_id=?").get(reverted.receipt_id)).toEqual({ kind: "revert" });
  const redone = await undoReceipt({ db, vault_path: f.restored, now: () => "2026-09-18T12:00:00.000Z" }, reverted.receipt_id);
  expect(redone.reverts).toBe(reverted.receipt_id);
  expect(readFileSync(join(f.restored, f.receipt.page_path), "utf8")).toBe(changed);
  recoverCanonWrites({ db, vault_path: f.restored });
  expect(db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 0 });
  expect(current.last_receipt).toBe(reverted.receipt_id);
});

for (const alteration of ["unknown-version", "unknown-field", "changed-basis", "downgraded-manifest", "removed-schema", "downgraded-receipt", "unlinked-downgrade"] as const) {
  test(`typed backup refuses ${alteration} before publishing a restore`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup);
    changeBackup(f.backup, row => {
      if (alteration === "unknown-version") return { ...row, schema: "kizuki.canon-receipt/v3" };
      if (alteration === "unknown-field") return { ...row, surprise: "ignored?" };
      if (alteration === "removed-schema") { const { schema: _schema, ...rest } = row; return rest; }
      if (alteration === "downgraded-receipt") { const { schema: _schema, state: _state, own_id_origin: _origin, basis: _basis, prior_receipt_id: _prior, ...rest } = row; return rest; }
      if (alteration === "unlinked-downgrade") { const { schema: _schema, state: _state, own_id_origin: _origin, basis: _basis, prior_receipt_id: _prior, ...rest } = row; return { ...rest, claim_ids: [] }; }
      if (alteration === "changed-basis") { const basis = structuredClone(f.receipt.basis); return { ...row, basis: { ...basis, after: basis.after!.map(value => ({ ...value, semantic_key: "0".repeat(64) })) } }; }
      return row;
    }, alteration === "downgraded-manifest" ? 4 : undefined);
    expect(() => restoreVault(f.backup, f.restored)).toThrow();
    expect(existsSync(f.restored)).toBe(false);
  });
}


test("actual writer erasure survives export and restore without resurrecting source or page", async () => {
  const f = await fixture();
  await runPurge(f.db, f.vault, { event_id: f.world.eventId }, "erase typed source and page");
  const receipts = readReceiptRecords(f.vault);
  expect(receipts).toHaveLength(2);
  expect(receipts.every(isErasedReceipt)).toBe(true);
  expect(existsSync(join(f.vault, f.receipt.page_path))).toBe(false);
  exportVault(f.db, f.vault, f.backup); restoreVault(f.backup, f.restored);
  const copy = openCopy(f.restored);
  expect(receipts.map(receipt => getCanonReceiptRecord(copy, receipt.receipt_id))).toEqual(receipts);
  expect(copy.query("SELECT event_id FROM events WHERE event_id=?").get(f.world.eventId)).toBeNull();
  expect(copy.query("SELECT count(*) AS n FROM claim_v2_semantics").get()).toEqual({ n: 0 });
  expect(existsSync(join(f.restored, f.receipt.page_path))).toBe(false);
  expect(readWorldView({ db: copy, vaultPath: f.restored, principal: OWNER }, {
    operation: "find_concepts", label: "Bayesian updating", valid: { kind: "all" }, knownAt: { kind: "current" },
  })).toMatchObject({ result: { data: { matches: [] } } });
});

test.each(["missing", "cycle", "fork"] as const)("restore rejects %s edges in entirely erased actual history", async mode => {
  const f = await fixture();
  await runPurge(f.db, f.vault, { event_id: f.world.eventId }, "erase all typed history");
  const receipts = readReceiptRecords(f.vault);
  expect(receipts).toHaveLength(2);
  exportVault(f.db, f.vault, f.backup);
  const forkParent = ulid();
  changeBackup(f.backup, row => {
    const prior = mode === "missing" ? ulid() : mode === "cycle"
      ? receipts.find(receipt => receipt.receipt_id !== row.receipt_id)!.receipt_id
      : forkParent;
    return eraseWorldReceipt(row.receipt_id as string, row.purge_receipt_id as string, row.erased_at as string, prior) as unknown as Record<string, unknown>;
  });
  // Manifest and individual receipt integrity are valid; the operation graph is not.
  expect(verifyBackup(f.backup).schema_versions.canon).toBe(5);
  expect(() => restoreVault(f.backup, f.restored)).toThrow();
  expect(existsSync(f.restored)).toBe(false);
});

test("a rehashed backup cannot detach a surviving page from its erased ancestry", async () => {
  const f = await fixture();
  await correct(f.io, { statement: "Use independent owner evidence.", target: { claim_id: f.world.claims[2]! } });
  await runPurge(f.db, f.vault, { event_id: f.world.eventId }, "erase original source");
  const records = readReceiptRecords(f.vault);
  expect(records.filter(isErasedReceipt)).toHaveLength(2);
  exportVault(f.db, f.vault, f.backup);
  changeBackup(f.backup, row => row.state === "retained" ? { ...row, prior_receipt_id: null } : row);
  expect(verifyBackup(f.backup).schema_versions.canon).toBe(5);
  expect(() => restoreVault(f.backup, f.restored)).toThrow("lineage invalid");
  expect(existsSync(f.restored)).toBe(false);
});


test("a rehashed correction receipt cannot acquire earlier assertions as undo ownership", async () => {
  const f = await fixture();
  const correction = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  exportVault(f.db, f.vault, f.backup);
  changeBackup(f.backup, row => {
    if (row.receipt_id !== correction.receipt_id) return row;
    const basis = row.basis as { before: { claim_id: string }[]; after: { claim_id: string }[] };
    return { ...row, claim_ids: [...new Set([...basis.before, ...basis.after].map(item => item.claim_id))] };
  });
  expect(verifyBackup(f.backup).schema_versions.canon).toBe(5);
  expect(() => restoreVault(f.backup, f.restored)).toThrow("ownership differs");
  expect(existsSync(f.restored)).toBe(false);
});
