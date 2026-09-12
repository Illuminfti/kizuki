import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, symlinkSync, truncateSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { purgeEvents, resumePurge } from "../../src/ledger/purge";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import { getCanonReceipt, listCanonReceipts, readReceiptsLog, RECEIPTS_PATH } from "../../src/canon/receipts";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { canonReadGeneration, inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { readCanonProjectionObligation, retryCanonProjectionObligations } from "../../src/canon/projection-obligations";
import { undoReceipt } from "../../src/canon/undo";
import { getClaim } from "../../src/claims/store";
import { createDurableWriteBudget, readDailyBudget, settleWriteReservations } from "../../src/serve/budget-ledger";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { bindLocalSourcePort, inspectSourceGrant, resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_DESCRIPTOR } from "../../src/retrieval/fts5";
import { temporaryPortContext } from "../contracts/fixtures";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { putEvent, storeClaim, write } from "./helpers";
import { ulid } from "../../src/util/ulid";
import { sha256Hex } from "../../src/util/hash";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
async function fixture(bound = false) {
  const vault = tempVault("canon-crash-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  let source: string | null = null, eventId: string;
  if (bound) {
    source = ulid(); registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "synthetic-grant", policy: {
      purposes: ["capture", "recall", "session", "derive", "extract", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
    const accepted = accept(db, { ...validEvent(), connector_id: "fixture" }, { source: { source_key: source, expected_revision: 1 } });
    if (accepted.status !== "stored") throw Error("synthetic event was not accepted");
    eventId = accepted.event.event_id;
  } else eventId = putEvent(db);
  const claim = await storeClaim(db, eventId);
  return { vault: vault.path, dbPath, source, eventId, claim,
    get db() { return db; }, get io() { return { db, vault_path: vault.path }; },
    reopen() { db.close(); db = openLedger(dbPath); },
  };
}
function failRow(db: ReturnType<typeof openLedger>) {
  db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic receipt storage failure'); END");
}
function allowRow(db: ReturnType<typeof openLedger>) { db.exec("DROP TRIGGER synthetic_receipt_failure"); }

test("unsafe receipt custody refuses before page, archive, budget or intent admission", async () => {
  const f = await fixture(), sentinel = join(f.vault, "sentinel");
  writeFileSync(sentinel, "synthetic outside bytes", { mode: 0o600 });
  mkdirSync(join(f.vault, ".kizuki", "receipts"), { recursive: true });
  symlinkSync(sentinel, join(f.vault, RECEIPTS_PATH));
  const budget = createBudgetTracker({ canon_writes_per_run: 1 });
  expect(() => applyCanonWrite(f.io, f.claim, resolveTarget(f.io, f.claim), { writer: "loop", budget })).toThrow("canon_receipt_stream_unsafe");
  expect(budget.usage().canon_writes_per_run.used).toBe(0);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  expect(existsSync(join(f.vault, "people/grace.md"))).toBe(false);
  expect(readFileSync(sentinel, "utf8")).toBe("synthetic outside bytes");
});

test("receipt-row failure survives reopen and completes exactly one original receipt and binding", async () => {
  const f = await fixture(); failRow(f.db);
  expect(() => write(f.io, f.claim)).toThrow("synthetic receipt storage failure");
  const pending = readCanonWriteIntent(f.db)!;
  expect(pending.receipt.claim_ids).toEqual([f.claim.claim_id]);
  expect(listCanonReceipts(f.db)).toEqual([]);
  expect(readReceiptsLog(f.vault)).toEqual([pending.receipt]);
  expect(getClaim(f.db, f.claim.claim_id)?.receipt_id).toBeNull();
  expect(canonReadGeneration(f.db)).toBe(1);
  f.reopen(); allowRow(f.db);
  expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  expect(readReceiptsLog(f.vault)).toEqual([pending.receipt]);
  expect(listCanonReceipts(f.db)).toEqual([pending.receipt]);
  expect(getClaim(f.db, f.claim.claim_id)?.receipt_id).toBe(pending.receipt.receipt_id);
  expect(canonReadGeneration(f.db)).toBe(3);
  expect(recoverCanonWrites(f.io).completed).toEqual([]);
});

test("top-level admission rejects enclosing transaction rollback before bytes for every ordinary writer", async () => {
  for (const writer of ["loop", "correction", "import"] as const) {
    const f = await fixture(), budget = createBudgetTracker({ canon_writes_per_run: 1 });
    f.db.exec("BEGIN IMMEDIATE");
    try { expect(() => applyCanonWrite(f.io, f.claim, resolveTarget(f.io, f.claim), { writer, budget })).toThrow("nested_transaction"); }
    finally { f.db.exec("ROLLBACK"); }
    expect(budget.usage().canon_writes_per_run.used).toBe(0);
    expect(existsSync(join(f.vault, "people/grace.md"))).toBe(false);
    expect(readCanonWriteIntent(f.db)).toBeNull();
  }
});

test("durable reservation is retained through failed completion and charged once after recovery", async () => {
  const f = await fixture(), day = "2026-09-07";
  const io = { ...f.io, now: () => `${day}T00:00:00.000Z` };
  const budget = createDurableWriteBudget(f.db, day, { canon_writes_per_run: 2, canon_writes_per_day: 2 });
  failRow(f.db);
  expect(() => applyCanonWrite(io, f.claim, resolveTarget(io, f.claim), { writer: "loop", budget })).toThrow();
  const id = readCanonWriteIntent(f.db)!.receipt.receipt_id;
  settleWriteReservations(f.db, f.vault);
  expect(f.db.query("SELECT receipt_id FROM canon_write_reservations").all()).toEqual([{ receipt_id: id }]);
  f.reopen(); allowRow(f.db); recoverCanonWrites(f.io); settleWriteReservations(f.db, f.vault); settleWriteReservations(f.db, f.vault);
  expect(f.db.query("SELECT 1 FROM canon_write_reservations").get()).toBeNull();
  expect(readDailyBudget(f.db, day, "canon_writes_per_day")).toBe(1);
  expect(readReceiptsLog(f.vault)).toHaveLength(1);
});

test("an exact torn receipt tail is completed under its original checkpoint once", async () => {
  const f = await fixture(); failRow(f.db); expect(() => write(f.io, f.claim)).toThrow();
  const intent = readCanonWriteIntent(f.db)!, path = join(f.vault, RECEIPTS_PATH);
  const complete = readFileSync(path);
  truncateSync(path, Math.floor(complete.length / 2));
  f.reopen(); allowRow(f.db);
  expect(recoverCanonWrites(f.io).completed).toEqual([intent.receipt.receipt_id]);
  expect(readFileSync(path)).toEqual(complete);
  expect(recoverCanonWrites(f.io).completed).toEqual([]);
  expect(listCanonReceipts(f.db)).toEqual([intent.receipt]);
});

test("an extra receipt after the intent tail is preserved and cannot complete its row", async () => {
  const f = await fixture(); failRow(f.db); expect(() => write(f.io, f.claim)).toThrow();
  const intent = readCanonWriteIntent(f.db)!, path = join(f.vault, RECEIPTS_PATH);
  appendFileSync(path, JSON.stringify({ ...intent.receipt, receipt_id: ulid() }) + "\n");
  const unknown = readFileSync(path);
  f.reopen(); allowRow(f.db); expect(() => recoverCanonWrites(f.io)).toThrow();
  expect(readFileSync(path)).toEqual(unknown);
  expect(listCanonReceipts(f.db)).toEqual([]);
  expect(readCanonWriteIntent(f.db)?.receipt.receipt_id).toBe(intent.receipt.receipt_id);
});

test("failed local projection preserves the old floor and replays after canon committed once", async () => {
  const f = await fixture(), original = write(f.io, f.claim);
  const before = f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all();
  expect(before).toHaveLength(1);
  const edit = await storeClaim(f.db, f.eventId, { kind: "edit", predicate: null, object: null, body: "Grace studies astronomy.", frontmatter: {} });
  f.db.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON search_documents BEGIN SELECT RAISE(FAIL,'synthetic projection storage failure'); END");
  expect(() => write(f.io, edit)).toThrow("synthetic projection storage failure");
  expect(f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all()).toEqual(before);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  const receipts = listCanonReceipts(f.db); expect(receipts).toHaveLength(2);
  expect(getClaim(f.db, edit.claim_id)?.receipt_id).toBe(receipts[1]!.receipt_id);
  expect(inspectCanonRecovery(f.db).projection_pending).toBe(1);
  f.reopen(); f.db.exec("DROP TRIGGER synthetic_projection_failure");
  expect((await retryCanonProjectionObligations(f.io)).completed).toEqual([receipts[1]!.receipt_id]);
  expect(listCanonReceipts(f.db)).toEqual(receipts);
  expect(readReceiptsLog(f.vault)).toEqual(receipts);
  expect(f.db.query<{ body: string }, []>("SELECT body FROM search_documents WHERE scope='canon'").get()?.body).toContain("astronomy");
  expect(readFileSync(join(f.vault, original.page_path), "utf8")).toContain("astronomy");
});

for (const change of ["bytes", "claim", "policy", "predecessor"] as const) {
  test(`exact published postimage cannot override changed ${change}`, async () => {
    const f = await fixture(change === "policy"); failRow(f.db);
    expect(() => write(f.io, f.claim)).toThrow(); const intent = readCanonWriteIntent(f.db)!;
    const path = join(f.vault, intent.receipt.page_path);
    if (change === "bytes") writeFileSync(path, "new owner bytes", { mode: 0o600 });
    if (change === "claim") f.db.query("UPDATE claims SET status='reverted' WHERE claim_id=?").run(f.claim.claim_id);
    if (change === "policy") revokeSourceGrant(f.db, { source_key: f.source!, expected_revision: 1, operation_id: "synthetic-revoke" });
    if (change === "predecessor") f.db.query("INSERT INTO page_index(page_id,rel_path,subject_key,last_receipt,last_hash) VALUES (?,?,NULL,NULL,?)").run(intent.completion.page_id, intent.receipt.page_path, intent.receipt.after_hash);
    const before = readFileSync(path); f.reopen(); allowRow(f.db);
    expect(() => recoverCanonWrites(f.io)).toThrow(change === "bytes" ? "page_changed" : change === "predecessor" ? "predecessor_changed" : "authority_changed");
    expect(readFileSync(path)).toEqual(before);
    expect(listCanonReceipts(f.db)).toEqual([]);
    expect(readCanonWriteIntent(f.db)?.receipt.receipt_id).toBe(intent.receipt.receipt_id);
  });
}

for (const phase of ["before_stage", "complete_stage", "published", "receipt_row", "archive_published"] as const) {
  test(`real process exit at ${phase} preserves the durable intent and exact recovery boundary`, async () => {
    const f = await fixture();
    let claim = f.claim;
    if (phase === "archive_published") {
      write(f.io, f.claim);
      claim = await storeClaim(f.db, f.eventId, { kind: "edit", predicate: null, object: null, body: "Grace studies astronomy.", frontmatter: {} });
    }
    const priorReceipts = listCanonReceipts(f.db);
    const src = join(import.meta.dir, "../../src");
    const script = `
      import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
      import { getClaim } from ${JSON.stringify(join(src, "claims/store.ts"))};
      import { resolveTarget } from ${JSON.stringify(join(src, "canon/arbiter.ts"))};
      import { createBudgetTracker } from ${JSON.stringify(join(src, "canon/budget.ts"))};
      import { applyCanonWriteOwned } from ${JSON.stringify(join(src, "canon/apply.ts"))};
      import { withCanonMutationSync,snapshotCanonIo,requireCanonFiles } from ${JSON.stringify(join(src, "canon/io.ts"))};
      const raw=openLedger(${JSON.stringify(f.dbPath)}), claim=getClaim(raw,${JSON.stringify(claim.claim_id)});
      const db=${JSON.stringify(phase)}==='receipt_row' ? new Proxy(raw,{get(target,key){
        if(key==='query')return sql=>{if(sql.includes('INSERT INTO canon_receipts'))process.exit(73);return target.query(sql);};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }}):raw;
      const io=snapshotCanonIo({db,vault_path:${JSON.stringify(f.vault)}});
      withCanonMutationSync(io,(scope,owned)=>{
        const files=requireCanonFiles(scope,owned), create=files.create.bind(files), publish=files.publish.bind(files);
        files.create=(...args)=>{if(${JSON.stringify(phase)}==='before_stage')process.exit(73);const result=create(...args);if(${JSON.stringify(phase)}==='complete_stage')process.exit(73);return result;};
        files.publish=(...args)=>{const result=publish(...args);if(${JSON.stringify(phase)}==='published'||${JSON.stringify(phase)}==='archive_published')process.exit(73);return result;};
        applyCanonWriteOwned(scope,owned,claim,resolveTarget(owned,claim),{writer:'loop',budget:createBudgetTracker({canon_writes_per_run:1})});
      }); process.exit(74);
    `;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15000 });
    expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
    f.reopen(); const pending = readCanonWriteIntent(f.db)!; expect(pending).not.toBeNull();
    if (phase === "complete_stage") {
      const stage = join(f.vault, pending.stages.live_stage), bytes = readFileSync(stage);
      expect(() => recoverCanonWrites(f.io)).toThrow("creation custody");
      expect(readFileSync(stage)).toEqual(bytes); expect(inspectCanonRecovery(f.db).pending).toBe(true);
    } else {
      expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
      expect(listCanonReceipts(f.db)).toEqual([...priorReceipts, pending.receipt]); expect(readReceiptsLog(f.vault)).toEqual([...priorReceipts, pending.receipt]);
    }
  });
}

test("historical unrecorded bytes are refused rather than granted a synthetic repair receipt", async () => {
  const f = await fixture(); failRow(f.db); expect(() => write(f.io, f.claim)).toThrow();
  const intent = readCanonWriteIntent(f.db)!;
  // Negative historical-orphan fixture: discard admission as an old release did.
  f.db.exec("DELETE FROM canon_write_intents"); allowRow(f.db);
  const other = await storeClaim(f.db, f.eventId, { kind: "edit", predicate: null, object: null, body: "A new claim.", frontmatter: {} });
  expect(() => applyCanonWrite(f.io, other, { action: "edit", page_id: intent.completion.page_id!, rel_path: intent.receipt.page_path, reason: "explicit" }, { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }) })).toThrow("historical_orphan");
  expect(listCanonReceipts(f.db)).toEqual([]);
});

test("v27 pending write recovers the same receipt after v28 migration", async () => {
  const f = await fixture();
  f.db.exec("ALTER TABLE event_purges DROP COLUMN proof_digest");
  f.db.query("UPDATE schema_version SET version = 27").run();
  failRow(f.db);
  expect(() => write(f.io, f.claim)).toThrow("synthetic receipt storage failure");
  const pending = readCanonWriteIntent(f.db)!;
  expect(pending.receipt.kind).toBe("write");
  f.reopen();
  allowRow(f.db);
  expect(f.db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
  expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  expect(listCanonReceipts(f.db)).toEqual([pending.receipt]);
  expect(recoverCanonWrites(f.io).completed).toEqual([]);
});

test("v27 pending purge-rewrite citing a purge receipt recovers the same receipt after v28 migration", async () => {
  const f = await fixture();
  const original = write(f.io, f.claim);
  const purged = purgeEvents(f.db, f.vault, { event_id: f.eventId }, "retire fixture");
  expect(purged.receipts).toHaveLength(1);
  f.db.exec("ALTER TABLE event_purges DROP COLUMN proof_digest");
  f.db.query("UPDATE schema_version SET version = 27").run();
  failRow(f.db);
  await expect(resumePurge(f.db, f.vault, purged.receipts[0]!.receipt_id)).rejects.toThrow(
    "synthetic receipt storage failure",
  );
  const pending = readCanonWriteIntent(f.db)!;
  expect(pending.receipt.kind).toBe("purge_rewrite");
  expect(pending.admission.events.map((item) => item.id)).toContain(f.eventId);
  expect(listCanonReceipts(f.db)).toEqual([original]);
  f.reopen();
  allowRow(f.db);
  expect(f.db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
  expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
  expect(readCanonWriteIntent(f.db)).toBeNull();
  expect(listCanonReceipts(f.db)).toEqual([original, pending.receipt]);
  expect(recoverCanonWrites(f.io).completed).toEqual([]);
});

test("v20 migration preserves canon and creates a closed empty v21 recovery ledger", async () => {
  const f = await fixture(), receipt = write(f.io, f.claim);
  f.db.exec("DROP TABLE IF EXISTS event_purge_proofs; DROP TABLE canon_write_intent_sources; DROP TABLE canon_projection_sources; DROP TABLE canon_write_intents; DROP TABLE canon_projection_obligations; DROP TABLE canon_read_generation; UPDATE schema_version SET version=20");
  f.reopen();
  expect(f.db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
  expect(listCanonReceipts(f.db)).toEqual([receipt]);
  expect(inspectCanonRecovery(f.db)).toEqual({ pending: false, receipt_id: null, page_path: null, projection_pending: 0, generation: 0 });
  expect(() => f.db.exec("INSERT INTO canon_read_generation VALUES (2,0)")).toThrow();
  expect(() => f.db.exec("UPDATE canon_read_generation SET generation=-1")).toThrow();
});

for (const mutation of ["version", "field", "image", "checkpoint", "sources", "source_closure", "derive_closure"] as const) {
  test(`closed persisted intent refuses ${mutation} corruption without changing page or receipt`, async () => {
    const f = await fixture(); failRow(f.db); expect(() => write(f.io, f.claim)).toThrow();
    const row = f.db.query<{ intent: string }, []>("SELECT intent FROM canon_write_intents").get()!;
    const intent = JSON.parse(row.intent);
    if (mutation === "version") intent.version = 2;
    if (mutation === "field") intent.authorized = true;
    if (mutation === "image") intent.after_base64 += "=";
    if (mutation === "checkpoint") intent.checkpoint.file.ino = "001";
    if (mutation === "sources") f.db.exec("DELETE FROM canon_write_intent_sources");
    if (mutation === "source_closure") {
      intent.admission.sources = []; intent.admission.events = []; intent.admission.derive_ids = [];
      f.db.exec("DELETE FROM canon_write_intent_sources");
    }
    if (mutation === "derive_closure") intent.admission.derive_ids = [];
    const json = JSON.stringify(intent);
    f.db.query("UPDATE canon_write_intents SET intent=?,digest=?").run(json, sha256Hex(json));
    expect(() => readCanonWriteIntent(f.db)).toThrow();
    const page = readFileSync(join(f.vault, intent.receipt.page_path)), log = readFileSync(join(f.vault, RECEIPTS_PATH));
    allowRow(f.db); expect(() => recoverCanonWrites(f.io)).toThrow();
    expect(readFileSync(join(f.vault, intent.receipt.page_path))).toEqual(page);
    expect(readFileSync(join(f.vault, RECEIPTS_PATH))).toEqual(log); expect(listCanonReceipts(f.db)).toEqual([]);
  });
}

test("undo commits receipt and lifecycle together, then a real FTS5 consumer retrieves restored bytes and trust labels", async () => {
  const f = await fixture(), temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  cleanup.push(temporary.cleanup); const port = createFts5RetrievalPort(temporary.ctx); cleanup.push(() => { void port.close(); });
  const io = { ...f.io, retrieval: port, retrieval_store: port.descriptor.id };
  const original = write(io, f.claim); await retryCanonProjectionObligations(io);
  const edit = await storeClaim(f.db, f.eventId, { kind: "edit", predicate: null, object: null, body: "Grace studies astronomy.", frontmatter: {} });
  const edited = write(io, edit); await retryCanonProjectionObligations(io);
  failRow(f.db); await expect(undoReceipt(io, edited.receipt_id)).rejects.toThrow("synthetic receipt storage failure");
  expect(getClaim(f.db, edit.claim_id)?.status).toBe("live"); expect(getCanonReceipt(f.db, edited.receipt_id)?.reverted_by).toBeNull();
  allowRow(f.db); const result = await undoReceipt(io, edited.receipt_id);
  expect(result.projection_pending).toBeUndefined(); expect(getClaim(f.db, edit.claim_id)?.status).toBe("reverted");
  const found = await port.search({ text: "partnerships", mode: "lexical", scope: { kinds: ["page"] }, ceiling: "private", limit: 5, deadline_ms: 1000 });
  expect(found.hits).toHaveLength(1); expect(found.hits[0]).toMatchObject({ doc_id: original.retrieval_ops[0]!.doc, kind: "page", sensitivity: original.sensitivity, taint: original.taint, authority: original.authority });
  expect(found.hits[0]!.snippet).toContain("partnerships");
  expect(inspectCanonRecovery(f.db).projection_pending).toBe(0);
});

test("known scheduled operation survives absent runtime and completes once a real engine is available", async () => {
  const f = await fixture(), temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  cleanup.push(temporary.cleanup);
  const io = { ...f.io, retrieval_store: FTS5_RETRIEVAL_DESCRIPTOR.id };
  const receipt = write(io, f.claim);
  expect(readCanonProjectionObligation(f.db, receipt.receipt_id)?.value.external_execution).toEqual(["scheduled"]);
  expect((await retryCanonProjectionObligations(io)).pending).toBe(1);
  const port = createFts5RetrievalPort(temporary.ctx); cleanup.push(() => { void port.close(); });
  expect((await retryCanonProjectionObligations({ ...io, retrieval: port })).completed).toEqual([receipt.receipt_id]);
  expect((await retryCanonProjectionObligations({ ...io, retrieval: port })).completed).toEqual([]);
  const result = await port.search({ text: "partnerships", mode: "lexical", scope: { kinds: ["page"] }, ceiling: "private", limit: 5, deadline_ms: 1000 });
  expect(result.hits).toHaveLength(1); expect(result.hits[0]?.doc_id).toBe(receipt.retrieval_ops[0]!.doc);
});

test("source revocation during actual engine upsert prevents acknowledgment and removes the exposed document", async () => {
  const f = await fixture(true), temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  cleanup.push(temporary.cleanup); const port = createFts5RetrievalPort(temporary.ctx); cleanup.push(() => { void port.close(); });
  bindLocalSourcePort(port, { store_id: "local:recovery-fts5" });
  const io = { ...f.io, retrieval: port, retrieval_store: port.descriptor.id };
  const receipt = write(io, f.claim), upsert = port.upsert.bind(port);
  port.upsert = async docs => {
    const result = await upsert(docs);
    revokeSourceGrant(f.db, { source_key: f.source!, expected_revision: 1, operation_id: "synthetic-revoke-during-upsert" });
    return result;
  };
  await expect(retryCanonProjectionObligations(io)).rejects.toThrow("authority_changed");
  expect(readCanonProjectionObligation(f.db, receipt.receipt_id)?.value.external_execution).toEqual(["started"]);
  expect((await port.verifyAbsent([receipt.retrieval_ops[0]!.doc])).found).toEqual([]);
  expect(inspectCanonRecovery(f.db).projection_pending).toBe(1);
  expect(getCanonReceipt(f.db, receipt.receipt_id)).toEqual(receipt);
});

test("child death after real engine mutation retains unknown execution even after the local lease is reacquired", async () => {
  const f = await fixture(), temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  cleanup.push(temporary.cleanup);
  const receipt = write({ ...f.io, retrieval_store: FTS5_RETRIEVAL_DESCRIPTOR.id }, f.claim);
  const src = join(import.meta.dir, "../../src");
  const script = `
    import {openLedger} from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import {createFts5RetrievalPort} from ${JSON.stringify(join(src, "retrieval/fts5.ts"))};
    import {retryCanonProjectionObligations} from ${JSON.stringify(join(src, "canon/projection-obligations.ts"))};
    const port=createFts5RetrievalPort({vault_path:${JSON.stringify(temporary.ctx.vault_path)},data_dir:${JSON.stringify(temporary.ctx.data_dir)},config:{},clock:()=>new Date().toISOString(),logger:()=>{},secrets:async()=>undefined});
    const upsert=port.upsert.bind(port);port.upsert=async docs=>{await upsert(docs);process.exit(73);};
    await retryCanonProjectionObligations({db:openLedger(${JSON.stringify(f.dbPath)}),vault_path:${JSON.stringify(f.vault)},retrieval:port});process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15000 });
  expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
  f.reopen(); expect(readCanonProjectionObligation(f.db, receipt.receipt_id)?.value.external_execution).toEqual(["started"]);
  const port = createFts5RetrievalPort(temporary.ctx); cleanup.push(() => { void port.close(); });
  const actual = await port.search({ text: "partnerships", mode: "lexical", scope: { kinds: ["page"] }, ceiling: "private", limit: 5, deadline_ms: 1000 });
  expect(actual.hits[0]?.doc_id).toBe(receipt.retrieval_ops[0]!.doc);
  await expect(retryCanonProjectionObligations({ ...f.io, retrieval: port })).rejects.toThrow("projection_pending");
  await expect(undoReceipt({ ...f.io, retrieval: port }, receipt.receipt_id)).rejects.toThrow("projection_pending");
  expect(getCanonReceipt(f.db, receipt.receipt_id)?.reverted_by).toBeNull();
  expect(readCanonProjectionObligation(f.db, receipt.receipt_id)?.value.external_execution).toEqual(["started"]);
});

test("pending revert after admit-before-stage crash restores independent B survivor on A revocation", async () => {
  const vault = tempVault("canon-crash-revert-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  const policy = {
    purposes: ["capture", "recall", "session", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only",
    sensitivity_floor: "private",
  } as const;
  const sourceA = ulid(), sourceB = ulid();
  registerConnection(db, "fixture", sourceA);
  registerConnection(db, "fixture", sourceB);
  setSourceGrant(db, { source_key: sourceA, expected_revision: 0, operation_id: "grant-a", policy });
  setSourceGrant(db, { source_key: sourceB, expected_revision: 0, operation_id: "grant-b", policy });
  const storedB = accept(db, { ...validEvent(), connector_id: "fixture", source_record_id: "b-music", text: "Grace studies music." },
    { source: { source_key: sourceB, expected_revision: 1 } });
  const storedA = accept(db, { ...validEvent(), connector_id: "fixture", source_record_id: "a-edit", text: "A overwrites music." },
    { source: { source_key: sourceA, expected_revision: 1 } });
  if (storedB.status !== "stored" || storedA.status !== "stored") throw new Error("fixture capture failed");
  const io = { db, vault_path: vault.path };
  const original = write(io, await storeClaim(db, storedB.event.event_id, { predicate: "preference.prefers", object: "music", body: "Grace studies music." }));
  const edited = write(io, await storeClaim(db, storedA.event.event_id, { kind: "edit", predicate: null, object: null, body: "A overwrites music.", frontmatter: {} }));
  const src = join(import.meta.dir, "../../src");
  const script = `
    import { openLedger } from ${JSON.stringify(join(src, "ledger/db.ts"))};
    import { undoReceiptOwned } from ${JSON.stringify(join(src, "canon/undo.ts"))};
    import { withCanonMutationAsync, snapshotCanonIo, requireCanonFiles } from ${JSON.stringify(join(src, "canon/io.ts"))};
    const io=snapshotCanonIo({db:openLedger(${JSON.stringify(dbPath)}),vault_path:${JSON.stringify(vault.path)}});
    await withCanonMutationAsync(io,async(scope,owned)=>{
      const files=requireCanonFiles(scope,owned);
      files.create=()=>{process.exit(73);};
      await undoReceiptOwned(scope,owned,${JSON.stringify(edited.receipt_id)},{});
    });
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15000 });
  expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
  db.close(); db = openLedger(dbPath);
  const pending = readCanonWriteIntent(db)!;
  expect(pending.receipt.kind).toBe("revert");
  expect(pending.receipt.reverts).toBe(edited.receipt_id);
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).toContain("A overwrites music.");
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).not.toContain("Grace studies music.");
  revokeSourceGrant(db, { source_key: sourceA, expected_revision: 1, operation_id: "revoke-pending-revert" });
  const grant = await resumeSourceRevocation(db, vault.path, "revoke-pending-revert", {
    ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) },
  });
  expect(grant.status).toBe("denied");
  expect(grant.purge_blockers).toContain("canon_recovery_pending");
  expect(inspectSourceGrant(db, sourceA)!.purge_blockers).toContain("canon_recovery_pending");
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).toContain("Grace studies music.");
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).not.toContain("A overwrites music.");
  expect(getCanonReceipt(db, original.receipt_id)?.page_path).toBe(original.page_path);
  expect(readReceiptsLog(vault.path).some(row => row.receipt_id === original.receipt_id && row.page_path === original.page_path)).toBe(true);
  const held = readCanonWriteIntent(db);
  expect(held?.receipt.kind).toBe("revert");
  expect(held?.receipt.receipt_id).toBe(pending.receipt.receipt_id);
  expect(recoverCanonWrites({ db, vault_path: vault.path })).toMatchObject({ completed: [], pending: true });
  expect(readCanonWriteIntent(db)?.receipt.receipt_id).toBe(pending.receipt.receipt_id);
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).toContain("Grace studies music.");
  expect(readFileSync(join(vault.path, original.page_path), "utf8")).not.toContain("A overwrites music.");
  expect(getCanonReceipt(db, original.receipt_id)?.page_path).toBe(original.page_path);
});
