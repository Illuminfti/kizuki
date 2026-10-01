import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, random, runCampaign } from "./harness";
import { ledger, prepare, retrieval } from "./fixture";
import { checkVault, retrievalProjection } from "./invariants";
import { correct, readRetrievalDocuments, rebuildRetrieval, restoreVault } from "../../packages/core/src";
import type { RetrievalHit } from "../../packages/core/src";
import { canonStageRelPath } from "../../packages/core/src/vault/write";

for (const damage of ["content", "long-content", "title", "authority", "taint", "sensitivity", "subjects", "missing"] as const) {
  test(`the oracle rejects native correction ${damage} outside its golden queries`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-correction-"));
    const fixture = await prepare(root, "correction");
    const vault = join(root, "vault"), db = ledger(vault), port = retrieval(vault);
    try {
      const id = fixture.claimIds[0]!;
      fixture.activeTargets = { claims: [id], receipts: [fixture.receiptIds[0]!] };
      const statement = damage === "long-content"
        ? `${"The researcher continues studying celestial objects. ".repeat(5)}The researcher now works at Northwind.`
        : "The researcher now works at Northwind.";
      const result = await correct({ db, vault_path: vault, retrieval: port }, {
        statement, target: { claim_id: id },
      });
      await rebuildRetrieval(db, vault, port);
      await checkVault(db, vault, fixture, false, port);
      const docs = readRetrievalDocuments(db, vault);
      const doc = docs.find(doc => doc.doc_id === `claim:${result.claim_ids[0]}`)!;
      expect(doc.text).toContain("Northwind");
      expect(doc.text).not.toMatch(/astronomy|lighthouse|Acme/i);
      if (damage === "content") {
        const [inventory] = JSON.parse(await retrievalProjection(port, docs)) as { hits: RetrievalHit[] }[];
        expect(inventory!.hits.map(hit => hit.doc_id).sort()).toEqual(docs.map(doc => doc.doc_id).sort());
        for (const doc of docs) expect(inventory!.hits.find(hit => hit.doc_id === doc.doc_id)).toMatchObject({
          snippet: doc.text, kind: doc.kind, sensitivity: doc.sensitivity, taint: doc.taint, authority: doc.authority,
        });
      }
      if (damage === "long-content") expect(doc.text.indexOf("Northwind")).toBeGreaterThan(160);
      if (damage === "missing") await port.remove([doc.doc_id]);
      else {
        const corrupted = { ...doc };
        switch (damage) {
          case "content": case "long-content": corrupted.text = doc.text.replace("Northwind", "Southwind"); break;
          case "title": corrupted.title = "Synthetic replacement title"; break;
          case "authority": corrupted.authority = "model_inference"; break;
          case "taint": corrupted.taint = doc.taint === "clean" ? "quoted" : "clean"; break;
          case "sensitivity": corrupted.sensitivity = "public"; break;
          case "subjects": corrupted.subjects = ["person:unrelated"]; break;
        }
        await port.upsert([corrupted]);
      }
      await expect(checkVault(db, vault, fixture, false, port)).rejects.toThrow("retrieval_rebuild_not_equal");
    } finally { await port.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
}

test("the native oracle refuses a saturated inventory instead of comparing a partial result", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-inventory-"));
  const fixture = await prepare(root, "canon");
  const vault = join(root, "vault"), db = ledger(vault), port = retrieval(vault);
  try {
    const doc = readRetrievalDocuments(db, vault).find(doc => doc.kind === "claim")!;
    await port.upsert(Array.from({ length: 101 }, (_, record) => ({ ...doc, doc_id: `claim:synthetic-extra-${record}` })));
    await expect(checkVault(db, vault, fixture, false, port)).rejects.toThrow("retrieval_projection_truncated");
  } finally { await port.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

for (const damage of ["doctrine", "control", "quarantine", "stage", "bounded-stage", "active-body", "active-provenance", "active-status"] as const) {
  test(`the oracle rejects ${damage} damage even without an acknowledgment`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-negative-"));
    const fixture = await prepare(root, "undo");
    const vault = join(root, "vault"), db = ledger(vault);
    try {
      await checkVault(db, vault, fixture);
      fixture.activeTargets = { claims: [fixture.claimIds[0]!], receipts: [fixture.receiptIds[0]!] };
      let code: string;
      if (damage === "doctrine") {
        rmSync(join(vault, "CANON.md")); code = "doctor_doctrine";
      } else if (damage === "control") {
        chmodSync(join(vault, ".kizuki", "kizuki.db"), 0o644); code = "doctor_control";
      } else if (damage === "quarantine") {
        const directory = join(vault, ".kizuki", "quarantine", "canon-stage");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, "foreign-stage"), "partial synthetic write", { mode: 0o600 });
        code = "doctor_quarantine";
      } else if (damage === "stage" || damage === "bounded-stage") {
        const path = damage === "stage" ? fixture.sentinelPath : `archive/${"a".repeat(240)}.md`;
        const stage = canonStageRelPath(path, fixture.receiptIds[0]!);
        mkdirSync(join(vault, "archive"), { recursive: true, mode: 0o700 });
        writeFileSync(join(vault, stage), "partial synthetic write", { mode: 0o600 });
        code = "orphan_stage";
      } else {
        const field = damage === "active-body" ? "body='corrupted synthetic claim'"
          : damage === "active-provenance" ? "provenance='[]'" : "status='skipped'";
        db.query(`UPDATE claims SET ${field} WHERE claim_id=?`).run(fixture.claimIds[0]!);
        code = "committed_claim_changed";
      }
      await expect(checkVault(db, vault, fixture)).rejects.toThrow(code);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const operation of OPERATIONS) {
  test(`seeded SIGKILL recovers ${operation}`, async () => {
    const report = await runCampaign({ seed: 17 + OPERATIONS.indexOf(operation), trials: 1, maxDelayMs: 4, operations: [operation] });
    expect(report.trials[0]).toMatchObject({ killed: true, failure: null });
    expect(report.ok).toBe(true);
  }, 120_000);
}

test("a seed reproduces kill delays; invalid budgets refuse before creating vaults", async () => {
  const first = random(0), second = random(0);
  expect(Array.from({ length: 16 }, first)).toEqual(Array.from({ length: 16 }, second));
  await expect(runCampaign({ seed: -1, trials: 1 })).rejects.toThrow("seed_must_be_uint32");
  await expect(runCampaign({ seed: 1, trials: 0 })).rejects.toThrow("trials_must_be_1_to_10000");
  await expect(runCampaign({ seed: 1, trials: 1, maxDelayMs: 1001 })).rejects.toThrow("delay_must_be_0_to_1000");
  await expect(runCampaign({ seed: 1, trials: 1, operations: ["purge"], cut: "acknowledged" })).rejects.toThrow("acknowledged_cut_requires_repeated_writes");
});

test("the oracle refuses unrelated file changes and projection loss before rebuilding", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-oracle-"));
  const fixture = await prepare(root, "rebuild");
  const vault = join(root, "vault"), db = ledger(vault);
  try {
    await checkVault(db, vault, fixture);
    writeFileSync(join(vault, fixture.sentinelPath), fixture.sentinelBytes + "\nChanged independent text.\n");
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("committed_file_changed");
    writeFileSync(join(vault, fixture.sentinelPath), fixture.sentinelBytes);
    db.query("DELETE FROM search_documents WHERE scope='canon'").run();
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("rebuild_not_equal");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the oracle detects changes to every committed claim, beyond its sentinel", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-preservation-"));
  const fixture = await prepare(root, "rebuild");
  const vault = join(root, "vault"), db = ledger(vault);
  try {
    await checkVault(db, vault, fixture);
    db.query("UPDATE claims SET corroboration=corroboration+1 WHERE claim_id=?").run(fixture.claimIds[0]!);
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("committed_claim_changed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a published restore must retain all baseline claims and bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-restore-"));
  const fixture = await prepare(root, "restore");
  const restored = join(root, "restored");
  restoreVault(join(root, "artifact"), restored);
  const db = ledger(restored);
  try {
    await checkVault(db, restored, fixture, true);
    db.query("UPDATE claims SET corroboration=corroboration+1 WHERE claim_id=?").run(fixture.claimIds[0]!);
    await expect(checkVault(db, restored, fixture, true)).rejects.toThrow("committed_claim_changed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a later write's target stays protected until its call begins", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-targets-"));
  const fixture = await prepare(root, "canon");
  const vault = join(root, "vault"), db = ledger(vault);
  try {
    fixture.activeTargets = { claims: [fixture.claimIds[0]!], receipts: [] };
    db.query("UPDATE claims SET corroboration=corroboration+1 WHERE claim_id=?").run(fixture.claimIds[1]!);
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("committed_claim_changed");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("SIGKILL after a real retrieval upsert recovers through the native mutation fence", async () => {
  const report = await runCampaign({ seed: 17, trials: 1, operations: ["canon"], cut: "projection-started" });
  expect(report.trials[0]?.killed).toBe(true);
  expect(report.trials[0]?.failure).toBeNull();
  expect(report.ok).toBe(true);
}, 60_000);

test("acknowledged writes survive SIGKILL before the next write", async () => {
  for (const operation of ["capture", "canon", "correction", "undo", "typed-canon", "typed-correction", "typed-undo"] as const) {
    const report = await runCampaign({ seed: 17, trials: 1, operations: [operation], cut: "acknowledged" });
    expect(report.ok).toBe(true);
    expect(report.trials[0]).toMatchObject({ killed: true, failure: null, acknowledgments: 1 });
  }
}, 120_000);

test("a journaled extraction decision survives SIGKILL without another producer call for its inputs", async () => {
  const report = await runCampaign({ seed: 17, trials: 1, operations: ["extraction"], cut: "extraction-journaled" });
  expect(report.trials[0]).toMatchObject({ killed: true, failure: null });
  expect(report.ok).toBe(true);
}, 60_000);

test("admitted purges finish after SIGKILL with an absence proof for every target", async () => {
  for (const operation of ["purge", "typed-purge"] as const) {
    const report = await runCampaign({ seed: 17, trials: 1, operations: [operation], cut: "purge-admitted" });
    expect(report.trials[0]).toMatchObject({ killed: true, failure: null });
    expect(report.ok).toBe(true);
  }
}, 120_000);

test("published exports, snapshots and restores remain complete after SIGKILL", async () => {
  for (const operation of ["export", "backup", "restore", "restore-snapshot"] as const) {
    const report = await runCampaign({ seed: 17, trials: 1, operations: [operation], cut: "acknowledged" });
    expect(report.ok).toBe(true);
    expect(report.trials[0]).toMatchObject({ killed: true, failure: null, acknowledgments: 1, partial_artifacts: 0 });
  }
}, 120_000);
