import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotCanonIo, withCanonMutationAsync, requireCanonFiles } from "../../src/canon/io";
import { undoReceipt } from "../../src/canon/undo";
import { correct } from "../../src/correction/correct";
import { createBudgetTracker } from "../../src/canon/budget";
import { exportVault } from "../../src/export";
import { runPurge, resumePurge } from "../../src/ledger/purge";
import { rebuildRetrieval } from "../../src/retrieval/rebuild";
import { tryWriteFlock } from "../../src/serve/flock";
import { createFileNotifier } from "../../src/serve/notifier-file";
import { ensureVaultId, ensureVaultIdOwned } from "../../src/serve/vault-id";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { withVaultMutationAsync } from "../../src/vault/mutation-scope";
import type { ProducerPort } from "../../src/contracts/producer";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import { canonFixture, putEvent, storeClaim, write, type CanonFixture } from "../canon/helpers";
import { FixtureVectorPort } from "../claims/helpers";

const fixtures: CanonFixture[] = [];
function fixture() { const result = canonFixture(); fixtures.push(result); return result; }
afterEach(() => { for (const item of fixtures.splice(0)) item.dispose(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function expectFree(path: string) { const lock = tryWriteFlock(path); expect(lock).not.toBeNull(); lock?.release(); }

const producerDescriptor: ProducerPort["descriptor"] = {
  id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1,
  supports: ["model"], requires_lease: false, optional_package: null,
};

test("write pass owns extraction, nested canon publication and receipt settlement", async () => {
  const f = fixture();
  await storeClaim(f.db, putEvent(f.db));
  const entered = deferred(), release = deferred();
  const producer: ProducerPort = {
    descriptor: producerDescriptor, health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    produce: async () => {
      entered.resolve(); await release.promise;
      expect(tryWriteFlock(f.vault)).toBeNull();
      return { status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] };
    },
  };
  const operation = runWritePass(f.db, f.vault, { budget: createBudgetTracker({ canon_writes_per_run: 2 }), producer,
    model_ref: "kizuki.llm.openai-compatible:synthetic@local", claims: { db: f.db } });
  await entered.promise;
  expect(tryWriteFlock(f.vault)).toBeNull();
  expect(() => exportVault(f.db, f.vault, `${f.vault}-backup`)).toThrow("busy");
  release.resolve();
  const result = await operation;
  expect(result.canon_writes).toBe(1);
  expect(result.errors).toEqual([]);
  expect(f.db.query("SELECT receipt_id FROM canon_receipts").all()).toHaveLength(1);
  expectFree(f.vault);
});

test("public correction and cascade undo reuse the enclosing writer", async () => {
  const f = fixture();
  const original = await storeClaim(f.db, putEvent(f.db));
  const first = write(f.io, original);
  const correction = correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: original.claim_id } });
  expect(tryWriteFlock(f.vault)).toBeNull();
  const corrected = await correction;
  expect(corrected.rewritten).toHaveLength(1);
  expectFree(f.vault);
  const undo = undoReceipt(f.io, first.receipt_id, { cascade: true });
  expect(tryWriteFlock(f.vault)).toBeNull();
  const reverted = await undo;
  expect(reverted.kind).toBe("revert");
  expect(existsSync(join(f.vault, first.page_path))).toBe(false);
  expectFree(f.vault);
});

test("undo holds ownership through asynchronous retrieval removal and absence proof", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const port = new FixtureVectorPort();
  const io = { ...f.io, retrieval: port, retrieval_store: port.descriptor.id };
  const receipt = write(io, await storeClaim(f.db, putEvent(f.db)));
  const originalRemove = port.remove.bind(port);
  port.remove = async ids => { entered.resolve(); await release.promise; expect(tryWriteFlock(f.vault)).toBeNull(); return originalRemove(ids); };
  const operation = undoReceipt(io, receipt.receipt_id);
  await entered.promise;
  expect(tryWriteFlock(f.vault)).toBeNull();
  release.resolve();
  const reverted = await operation;
  expect(reverted.retrieval_ops[0]?.op).toBe("remove");
  expectFree(f.vault);
});

test("purge resume verifies and rewrites under one owned scope", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const receipt = write(f.io, await storeClaim(f.db, event));
  const port = new FixtureVectorPort({ provenanceErasure: true });
  const verify = port.verifyAbsent.bind(port);
  let pending = true, checked = 0;
  port.verifyAbsent = async ids => {
    checked += 1; expect(tryWriteFlock(f.vault)).toBeNull();
    const proof = await verify(ids);
    return pending ? { ...proof, found: ids.slice(0, 1) } : proof;
  };
  const purged = await runPurge(f.db, f.vault, { event_id: event }, "retire synthetic fixture", { retrieval: port });
  expect(purged.rewritten).toEqual([]);
  pending = false;
  const resumed = await resumePurge(f.db, f.vault, purged.receipts[0]!.receipt_id, { retrieval: port });
  expect(resumed.ok).toBe(true);
  expect(checked).toBeGreaterThan(1);
  expect(readFileSync(join(f.vault, receipt.page_path), "utf8")).not.toContain("Grace runs partnerships at Acme.");
  expectFree(f.vault);
});

test("owned descriptors and nested identity maintenance live until callback cleanup settles", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  let captured: ReturnType<typeof requireCanonFiles> | undefined;
  const operation = withCanonMutationAsync(snapshotCanonIo(f.io), async (scope, io) => {
    captured = requireCanonFiles(scope, io);
    const id = ensureVaultIdOwned(scope, io, captured, "machine-fixture");
    expect(ensureVaultId(f.vault, "machine-fixture")).toBe(id);
    try { entered.resolve(); await release.promise; }
    finally {
      const page = captured.read("CANON.md");
      try { expect(page?.bytes.length).toBeGreaterThan(0); } finally { page?.close(); }
    }
  });
  await entered.promise;
  expect(tryWriteFlock(f.vault)).toBeNull();
  release.resolve(); await operation;
  expect(() => captured!.read("CANON.md")).toThrow("closed");
  expectFree(f.vault);
});

test("init, identity changes and notifications contend with the exporter writer", async () => {
  const f = fixture();
  const id = ensureVaultId(f.vault, "machine-a");
  const notifier = createFileNotifier(f.vault);
  const notice = { notification_id: "2026-09-06-ordinary", title: "brief: ordinary", body: "Synthetic brief.\n", sensitivity: "personal" as const, provenance: [] };
  await withVaultMutationAsync(f.io, async () => {
    expect(() => initVault(f.vault)).toThrow("busy");
    expect(initVault(f.vault, { dryRun: true }).dry_run).toBe(true);
    expect(ensureVaultId(f.vault, "machine-a")).toBe(id);
    expect(() => ensureVaultId(f.vault, "machine-b")).toThrow("busy");
    await expect(notifier.notify(notice)).rejects.toThrow("busy");
  });
  expect(initVault(f.vault).status).toBe("ready");
  expect(ensureVaultId(f.vault, "machine-b")).not.toBe(id);
  await notifier.notify(notice);
  await notifier.notify({ ...notice, body: "Updated synthetic brief.\n" });
  expect(readFileSync(join(f.vault, "dashboards/brief-2026-09-06.md"), "utf8")).toBe("Updated synthetic brief.\n");
  expectFree(f.vault);
});

test("retrieval deadline retains ownership through the late result and cleanup proof", async () => {
  const f = fixture(), entered = deferred(), release = deferred(), cleaning = deferred(), cleaned = deferred();
  await storeClaim(f.db, putEvent(f.db));
  class Port extends FixtureVectorPort {
    override readonly descriptor = { ...new FixtureVectorPort().descriptor, method_timeouts_ms: { rebuildFromDocuments: 5 } };
    async rebuildFromDocuments(docs: readonly RetrievalDoc[]) { entered.resolve(); await release.promise; await this.upsert(docs); }
    override async remove(ids: readonly string[]) { cleaning.resolve(); await cleaned.promise; return super.remove(ids); }
  }
  const port = new Port();
  const operation = rebuildRetrieval(f.db, f.vault, port).then(() => null, error => error);
  await entered.promise;
  expect(String(await operation)).toContain("timed out");
  expect(tryWriteFlock(f.vault)).toBeNull();
  release.resolve(); await cleaning.promise;
  expect(tryWriteFlock(f.vault)).toBeNull();
  cleaned.resolve();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expectFree(f.vault);
  expect(port.docs.size).toBe(0);
});
