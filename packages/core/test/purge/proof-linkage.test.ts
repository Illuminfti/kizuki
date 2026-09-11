import { afterEach, expect, test } from "bun:test";
import { accept } from "../../src/ledger/ledger";
import { openLedger } from "../../src/ledger/db";
import {
  createVaultFts5Port,
  runPurge,
  verifyPurge,
} from "../../src/ledger/purge";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";

const AT = "2026-09-02T12:00:00.000Z";
const fixtures: { dispose: () => void }[] = [];
afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

test("verify reports journal operation ids and keeps a failed op pending", async () => {
  const db = openLedger(":memory:");
  const disk = tempVault("kizuki-purge-linkage-");
  fixtures.push({ dispose: () => { db.close(); disk.dispose(); } });
  const stored = accept(db, { ...validEvent(), source_record_id: "acme.md", text: "acme" });
  if (stored.status !== "stored") throw new Error("expected stored event");
  const port = createVaultFts5Port(disk.path, () => AT);
  fixtures.push({ dispose: () => { void port.close(); } });
  await port.upsert([{
    doc_id: `event:${stored.event.event_id}`,
    kind: "event",
    title: "acme",
    text: "acme",
    sensitivity: "personal",
    taint: "clean",
    authority: "connector_evidence",
    subjects: [],
    provenance: [stored.event.event_id],
    occurred_at: AT,
    updated_at: AT,
  }]);

  const outcome = await runPurge(db, disk.path, { event_id: stored.event.event_id }, "source deleted", {
    retrieval: port,
    now: () => AT,
  });
  const receipt = outcome.receipts[0]!.receipt_id;
  const first = await verifyPurge(db, disk.path, receipt, { retrieval: port, now: () => AT });
  expect(first.ok).toBe(true);
  expect(first.batch_id).toBe(receipt);
  expect(first.operations.length).toBeGreaterThan(0);
  const live = db.query<{ op_id: string; store: string; state: "pending" | "done" }, []>(
    "SELECT op_id, store, state FROM purge_ops ORDER BY op_id",
  ).all();
  expect(first.operations.map((op) => ({ op_id: op.op_id, store: op.store, state: op.state }))).toEqual(
    live.map((row) => ({ op_id: row.op_id, store: row.store, state: row.state })),
  );
  expect(first.proofs).toHaveLength(live.length);

  const extraId = `${receipt}deadop`;
  db.query(
    `INSERT INTO purge_ops(op_id, receipt_id, store, ids, state, proof, created_at, done_at)
     VALUES (?, ?, 'kizuki.retrieval.missing', '[]', 'pending', NULL, ?, NULL)`,
  ).run(extraId, receipt, AT);

  const second = await verifyPurge(db, disk.path, receipt, { retrieval: port, now: () => AT });
  expect(second.ok).toBe(false);
  expect(second.batch_id).toBe(receipt);
  const byId = new Map(second.operations.map((op) => [op.op_id, op]));
  expect(byId.get(live[0]!.op_id)?.state).toBe("done");
  expect(byId.get(extraId)?.state).toBe("pending");
  expect(byId.get(extraId)?.store).toBe("kizuki.retrieval.missing");
  expect(second.proofs.every((proof) => proof.store !== "kizuki.retrieval.missing")).toBe(true);
  expect(db.query<{ state: string }, [string]>("SELECT state FROM purge_ops WHERE op_id=?").get(extraId)).toEqual({
    state: "pending",
  });
});
