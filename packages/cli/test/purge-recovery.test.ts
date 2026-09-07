import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, createVaultFts5Port, insertClaim, serializePage } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { purgeEvents, setAfterCanonSnapshot, setPurgeRecoveryHook } from "../../core/src/ledger/purge";
import { FTS5_RETRIEVAL_ID, FTS5_RETRIEVAL_STORE_REL } from "../../core/src/retrieval";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
const AT = "2026-09-06T16:00:00.000Z";
afterEach(() => { setAfterCanonSnapshot(); setPurgeRecoveryHook(); cleanup(); });

async function fixture() {
  const setup = tempVault();
  const path = join(setup.vault, ".kizuki", "kizuki.db");
  const db = openLedger(path);
  const event = (name: string, connector: string) => {
    const stored = accept(db, {
      schema: "kizuki.event/v1", connector_id: connector, source_record_id: name, kind: "message",
      text: name, occurred_at: AT, observed_at: AT, subjects: [], attachments: [], metadata: {}, sensitivity_hint: "personal", deleted: false,
    });
    if (stored.status !== "stored") throw new Error("ordinary event was not stored");
    return stored.event;
  };
  const erased = event("Retired Atlas", "fixture"), second = event("Retired Beacon", "fixture"), kept = event("Current Atlas", "fixture-kept");
  const body = "Retiredword Atlas fixture.";
  await insertClaim({ db, now: () => AT }, {
    kind: "claim", target: "facts/atlas", body, provenance: [erased.event_id],
    producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "quoted",
  });
  const page = (id: string) => writeFileSync(join(setup.vault, `facts/${id}.md`), serializePage({
    data: { id, title: id, type: "fact", status: "active", sensitivity: "personal", taint: "quoted", sources: [`event:${erased.event_id}`, kept.event_id] },
    body: `${body}\nCurrent Atlas notes.\n`,
  }));
  page("atlas");
  const port = createVaultFts5Port(setup.vault, () => AT);
  await port.upsert([{
    doc_id: "page:external-fixture", kind: "page", title: "Atlas", text: body, sensitivity: "personal", taint: "quoted",
    authority: "connector_evidence", subjects: [], provenance: [erased.event_id], occurred_at: AT, updated_at: AT,
  }]);
  return { ...setup, path, db, port, erased, second, kept, body, page };
}

for (const cut of ["phase-one-committed", "discovery-held"] as const) {
  test(`CLI --verify resumes ${cut} recovery through a non-first event receipt`, async () => {
    const f = await fixture();
    let alias = "";
    try {
      setAfterCanonSnapshot(() => f.page("late-atlas"));
      setPurgeRecoveryHook(stage => { if (stage === cut) throw new Error("ordinary recovery fixture interruption"); });
      expect(() => purgeEvents(f.db, f.vault, { connector_id: "fixture" }, "retire fixture", {
        retrieval_store: f.port.descriptor.id, now: () => AT,
      })).toThrow("ordinary recovery fixture interruption");
      setAfterCanonSnapshot(); setPurgeRecoveryHook();
      alias = f.db.query<{ receipt_id: string }, []>(
        "SELECT receipt_id FROM purge_batch_receipts WHERE receipt_id!=batch_id",
      ).get()!.receipt_id;
      expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "discovering" }]);
    } finally { await f.port.close(); f.db.close(); }
    const result = runCli(f.env, "purge", "--verify", alias, "--json");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("ok");
    expect(report.data).toMatchObject({ receipt_id: alias, ok: true, pages_rewritten: 2, hold_lifted: true });
    expect(report.data.ops[0]).toMatchObject({ state: "done", found: [], provenance: { checked: 2, found: [] } });
    const db = openLedger(f.path);
    try {
      expect(db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "ready" }]);
      expect(db.query("SELECT 1 FROM canon_holds").all()).toEqual([]);
      const ids = db.query<{ ids: string }, []>("SELECT ids FROM purge_ops").get()!.ids;
      expect(JSON.parse(ids)).toContain("page:late-atlas");
    } finally { db.close(); }
    const text = readFileSync(join(f.vault, "facts/late-atlas.md"), "utf8");
    expect(text).not.toContain(f.body);
    expect(text).toContain("Current Atlas notes.");
    const again = runCli(f.env, "purge", "--verify", alias);
    expect(again.exitCode).toBe(0);
    expect(readFileSync(join(f.vault, "facts/late-atlas.md"), "utf8")).toBe(text);
  });
}

test("CLI reports pending provenance when exact document proofs are empty and retries the failed removal", async () => {
  const f = await fixture();
  let receipt = "";
  try {
    receipt = purgeEvents(f.db, f.vault, { event_id: f.erased.event_id }, "retire fixture", {
      retrieval_store: f.port.descriptor.id, now: () => AT,
    }).receipts[0]!.receipt_id;
  } finally { await f.port.close(); f.db.close(); }
  const storePath = join(f.vault, ".kizuki", "retrieval", FTS5_RETRIEVAL_ID, FTS5_RETRIEVAL_STORE_REL);
  const retained = new Database(storePath);
  try {
    // Ordinary failure fixture: the backend temporarily cannot delete its copy.
    retained.exec(`CREATE TRIGGER ordinary_retention BEFORE DELETE ON search_documents
      WHEN OLD.doc_id='page:external-fixture' BEGIN SELECT RAISE(FAIL,'ordinary backend retention'); END`);
  } finally { retained.close(); }
  const json = runCli(f.env, "purge", "--verify", receipt, "--json");
  expect(json.exitCode).toBe(1);
  const report = JSON.parse(json.stdout);
  expect(report.status).toBe("error");
  expect(report.data.ok).toBe(false);
  expect(report.data.ops[0]).toMatchObject({ state: "pending", found: [], provenance: { checked: 1, found: [f.erased.event_id] } });
  const human = runCli(f.env, "purge", "--verify", receipt);
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toMatch(/found 0\s+pending\s+provenance checked 1\s+found 1/);
  expect(human.stdout).not.toMatch(/found 0\s+done/);
  expect(human.stderr).toContain(`retry: kizuki purge --verify ${receipt}`);
  const released = new Database(storePath);
  try { released.exec("DROP TRIGGER ordinary_retention"); } finally { released.close(); }
  const complete = runCli(f.env, "purge", "--verify", receipt, "--json");
  expect(complete.exitCode).toBe(0);
  expect(JSON.parse(complete.stdout).data.ops[0]).toMatchObject({ state: "done", found: [], provenance: { found: [] } });
});
