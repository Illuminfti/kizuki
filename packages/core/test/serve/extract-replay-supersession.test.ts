import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportVault, restoreVault } from "../../src/export";
import { createWorldRegistry, worldPredicate } from "../../src/contracts/world-kinds";
import { WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { openLedger } from "../../src/ledger/db";
import { modelProducerFingerprint } from "../../src/producer/fingerprint";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { readExtractCursor } from "../../src/serve/extract";
import { activeExtractReplay, replayEmptyExtractSegment, type EmptySegmentReplaySupersessionPlan } from "../../src/serve/extract-replay";
import { pruneRunReceipts, runReceiptsPath } from "../../src/serve/receipts";
import { runRail } from "../../src/serve/rails";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { storeClaim } from "../canon/helpers";
import { replayFixture } from "./extract-replay-fixture";
import { MODEL, writeServeToml } from "./throughput-fixture";

const fixtures: ReturnType<typeof replayFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const oldRegistry = createWorldRegistry([...WORLD_VOCABULARY_MODULES,
  { kind: null, offeredToProducer: false, predicates: [worldPredicate({ predicate: "concept.synthetic_replay_marker", subject: "concept", objects: ["literal"] })] },
]);

async function fixture(passes = 1) {
  // Exercise an actual qualified factory across two synthetic build registries.
  // No registration bypass or fabricated producer property enters the positive path.
  const f = await withWorldRegistry(oldRegistry, async () => {
    const f = replayFixture(); fixtures.push(f);
    replayEmptyExtractSegment({ db: f.db, vault_path: f.vault, producer: f.producer }, f.plan);
    writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=1\nmax_input_tokens=5000\n');
    for (let i = 0; i < passes; i++) {
      const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
      expect(result.status).toBe("ok");
      expect(result.stopped).toBeNull();
    }
    return f;
  });
  const current = f.db.query<{ done_utf16: number; updated_at: string }, []>("SELECT done_utf16,updated_at FROM extract_oversized_records").get()!;
  const settlements = f.db.query<Record<string, unknown>, []>(`SELECT decision_id,run_id,content_hash,start_utf16,end_utf16,chars,producer_fingerprint,model_binding_digest,outcome,replay_operation_id
    FROM extract_segment_settlements ORDER BY start_utf16,decision_id`).all();
  const runs = [...new Set(settlements.map(row => String(row.run_id)))].sort().map(run_id => {
    const report = f.db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id=?").get(run_id)!.report;
    return { run_id, report_sha256: sha256Hex(report) };
  });
  const plan: EmptySegmentReplaySupersessionPlan = { ...f.plan, schema: "kizuki.extract-empty-replay/v2", operation_id: "a-synthetic-child",
    old_producer_fingerprint: f.plan.new_producer_fingerprint, new_producer_fingerprint: modelProducerFingerprint(f.producer)!,
    old_run_id: runs[0]!.run_id, old_run_receipt_sha256: runs[0]!.report_sha256,
    parent: { operation_id: f.plan.operation_id, plan_sha256: sha256Hex(canonicalJson(f.plan)),
      current_done_utf16: current.done_utf16, current_updated_at: current.updated_at,
      settlements_sha256: sha256Hex(canonicalJson(settlements)), run_receipts_sha256: sha256Hex(canonicalJson(runs)) } };
  expect(plan.new_producer_fingerprint).not.toBe(plan.old_producer_fingerprint);
  const apply = (raw: unknown = plan) => replayEmptyExtractSegment({ db: f.db, vault_path: f.vault, producer: f.producer }, raw);
  const progress = () => f.db.query("SELECT * FROM extract_oversized_records").all();
  return { ...f, child: plan, apply, progress };
}

test("v2 atomically replaces the active parent and completes the exact whole cap through ordinary extraction", async () => {
  const f = await fixture(2);
  const immutable = f.db.query("SELECT * FROM extract_replay_receipts").all();
  const settled = f.db.query("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all();
  const reports = f.db.query("SELECT * FROM run_receipts ORDER BY run_id").all();
  const calls = f.calls.length;
  const accepted = f.apply();
  expect(accepted).toMatchObject({ status: "accepted", start_utf16: 0, end_utf16: f.plan.segment.done_utf16 });
  expect(f.progress()).toMatchObject([{ done_utf16: 0, pending_end_utf16: null, replay_operation_id: f.child.operation_id }]);
  expect(f.calls).toHaveLength(calls);
  expect(f.apply()).toEqual({ ...accepted, status: "already_applied" });
  expect(f.db.query("SELECT * FROM extract_replay_receipts WHERE operation_id=?").all(f.plan.operation_id)).toEqual(immutable);
  expect(f.db.query("SELECT * FROM extract_segment_settlements ORDER BY start_utf16").all()).toEqual(settled);
  expect(f.db.query("SELECT * FROM run_receipts ORDER BY run_id").all()).toEqual(reports);
  await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(f.apply().status).toBe("already_applied");
  writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=100000\n');
  let captures = 0;
  const result = await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL,
    sync: async () => { captures++; throw new Error("unexpected capture"); } } });
  expect(result.stopped).toBe("extract:replay_complete");
  expect(captures).toBe(0);
  expect(f.calls.slice(calls).join("")).toBe(f.event.text.slice(0, f.plan.segment.done_utf16));
  expect(f.progress()).toMatchObject([{ done_utf16: f.plan.segment.done_utf16, replay_operation_id: null }]);
  expect(readExtractCursor(f.db)).toBe(f.plan.expected_cursor);
  expect(f.db.query("SELECT DISTINCT producer_fingerprint,replay_operation_id FROM extract_segment_settlements WHERE replay_operation_id=?").all(f.child.operation_id))
    .toEqual([{ producer_fingerprint: f.child.new_producer_fingerprint, replay_operation_id: f.child.operation_id }]);
  expect(() => f.apply()).toThrow("replay_conflict");
});

for (const [label, patch] of Object.entries({
  content: { content_hash: "f".repeat(64) }, text: { text_hash: "f".repeat(64) }, source: { source_key: "other-source" },
  revision: { source_revision: 2 }, epoch: { source_epoch: 2 }, cursor: { expected_cursor: "other-cursor" },
  binding: { model_binding_digest: "f".repeat(64) }, producer: { new_producer_fingerprint: "f".repeat(64) },
  previous_producer: { old_producer_fingerprint: "f".repeat(64) },
})) test(`v2 refuses changed ${label} before resetting parent progress`, async () => {
  const f = await fixture(), before = f.progress(), calls = f.calls.length;
  expect(() => f.apply({ ...f.child, ...patch })).toThrow();
  expect(f.progress()).toEqual(before);
  expect(f.calls).toHaveLength(calls);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

test("v2 refuses cap expansion, stale parent snapshots, alternate children and CAS failure without partial receipts", async () => {
  const f = await fixture(), before = f.progress();
  for (const patch of [
    { segment: { ...f.child.segment, done_utf16: f.child.segment.done_utf16 + 1 } },
    { parent: { ...f.child.parent, current_done_utf16: f.child.parent.current_done_utf16 + 1 } },
    { parent: { ...f.child.parent, current_updated_at: "2026-10-22T00:00:00.000Z" } },
    { parent: { ...f.child.parent, plan_sha256: "f".repeat(64) } },
  ]) {
    expect(() => f.apply({ ...f.child, ...patch })).toThrow();
    expect(f.progress()).toEqual(before);
  }
  f.db.exec("CREATE TRIGGER synthetic_v2_cas BEFORE UPDATE OF done_utf16 ON extract_oversized_records BEGIN SELECT RAISE(IGNORE); END");
  expect(() => f.apply()).toThrow("segment_changed");
  expect(f.progress()).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
  expect(f.db.query("SELECT * FROM leases").all()).toEqual([]);
  f.db.exec("DROP TRIGGER synthetic_v2_cas");
  f.apply();
  const reset = f.progress();
  expect(() => f.apply({ ...f.child, operation_id: "alternate-child" })).toThrow("replay_conflict");
  expect(() => f.apply({ ...f.child, new_review_sha256: "f".repeat(64) })).toThrow("replay_conflict");
  expect(f.progress()).toEqual(reset);
});

for (const [label, mutate] of Object.entries({
  usage: (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("INSERT INTO extract_usage VALUES('pending',NULL,'{}',1,'2026-10-22T00:00:00Z')"),
  batches: (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("INSERT INTO extract_batches(previous_cursor,cursor,drafts,created_at) VALUES('synthetic-from','synthetic-to','[]','2026-10-22T00:00:00Z')"),
  purge: (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("INSERT INTO purge_ops VALUES('synthetic-purge','synthetic-receipt','synthetic-store','[]','pending',NULL,'2026-10-22T00:00:00Z',NULL)"),
  canon: (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("INSERT INTO canon_write_intents VALUES(1,'synthetic-receipt','synthetic.md','{}','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')"),
  pending: (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("UPDATE extract_oversized_records SET pending_end_utf16=done_utf16+1"),
  revocation: (f: Awaited<ReturnType<typeof fixture>>) => revokeSourceGrant(f.db, { source_key: f.plan.source_key, expected_revision: 1, operation_id: "synthetic-revoke-parent" }),
  claims: async (f: Awaited<ReturnType<typeof fixture>>) => { await storeClaim(f.db, f.event.event_id, { producer: "model", model_ref: MODEL }); },
})) test(`v2 refuses ${label} without cleaning or resetting existing work`, async () => {
  const f = await fixture(); await mutate(f);
  const before = f.progress();
  expect(() => f.apply()).toThrow();
  expect(f.progress()).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

for (const [label, sql] of Object.entries({
  decision: "UPDATE extract_segment_settlements SET decision_id='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE start_utf16=0",
  run: "UPDATE extract_segment_settlements SET run_id='synthetic-wrong-run'",
  deletion: "DELETE FROM extract_segment_settlements WHERE start_utf16=0",
  overlap: "UPDATE extract_segment_settlements SET start_utf16=1 WHERE start_utf16=0",
  outcome: "UPDATE extract_segment_settlements SET outcome='nonempty' WHERE start_utf16=0",
  extra: `INSERT INTO extract_segment_settlements SELECT 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',event_id,run_id,content_hash,end_utf16,end_utf16+1,chars,producer_fingerprint,model_binding_digest,outcome,replay_operation_id,created_at FROM extract_segment_settlements ORDER BY end_utf16 DESC LIMIT 1`,
})) test(`v2 refuses parent settlement ${label} tampering`, async () => {
  const f = await fixture(2);
  // Synthetic on-disk corruption bypasses the normal immutable update guard.
  f.db.exec("DROP TRIGGER extract_segment_settlements_immutable");
  f.db.exec(sql);
  const before = f.progress();
  expect(() => f.apply()).toThrow();
  expect(f.progress()).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

for (const [label, patch] of Object.entries({
  capture: { events_synced: 1 }, writes: { canon_writes: 1 }, reverted: { canon_reverts: 1 }, claims: { claims_extracted: 1 },
  rejected: { claims_rejected: { synthetic: 1 } }, errors: { errors: ["synthetic failure"] }, model: { model: null },
  unknown: { model: { calls: 1, answered: 1, unavailable: 0, last_request: "answered", input_tokens: 1, output_tokens: 1, usage_unknown: true } },
})) test(`v2 refuses rehashed parent report with ${label}`, async () => {
  const f = await fixture();
  const row = f.db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id=?").get(f.child.old_run_id)!;
  const report = JSON.stringify({ ...JSON.parse(row.report), ...patch });
  f.db.query("UPDATE run_receipts SET report=? WHERE run_id=?").run(report, f.child.old_run_id);
  const rehashed = { ...f.child, old_run_receipt_sha256: sha256Hex(report), parent: { ...f.child.parent,
    run_receipts_sha256: sha256Hex(canonicalJson([{ run_id: f.child.old_run_id, report_sha256: sha256Hex(report) }])) } };
  const before = f.progress();
  expect(() => f.apply(rehashed)).toThrow("historical_evidence_invalid");
  expect(f.progress()).toEqual(before);
});

function rewriteBackup(backup: string, path: string, transform: (rows: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  const file = join(backup, path);
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const changed = transform(rows);
  const payload = changed.map(row => JSON.stringify(row) + "\n").join("");
  writeFileSync(file, payload);
  manifest.files[path] = { ...manifest.files[path], count: changed.length, size: Buffer.byteLength(payload), sha256: sha256Hex(payload) };
  const { manifest_sha256: _old, ...unsigned } = manifest;
  const files: Record<string, unknown> = {};
  for (const key of Object.keys(unsigned.files).sort()) files[key] = unsigned.files[key];
  const signed = { ...unsigned, files };
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({ ...signed, manifest_sha256: sha256Hex(JSON.stringify(signed, null, 2) + "\n") }, null, 2) + "\n");
}

for (const completed of [false, "partial", true] as const) test(`v2 backup restores full lineage with child sorted before parent, completed=${completed}`, async () => {
  const f = await fixture(2); f.apply();
  if (completed === true) {
    writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=100000\n');
    await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  }
  if (completed === "partial") await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  const pinned = f.db.query<{ run_id: string; report: string }, []>("SELECT run_id,report FROM run_receipts ORDER BY run_id").all();
  const unreferenced = JSON.parse(pinned[0]!.report);
  unreferenced.run_id = "synthetic-unreferenced-run";
  f.db.query("INSERT INTO run_receipts VALUES(?,'sync',?,?,'ok',NULL,?)").run(unreferenced.run_id, unreferenced.started_at, unreferenced.finished_at, JSON.stringify(unreferenced));
  const pruned = pruneRunReceipts(f.db, f.vault, "2100-01-01T00:00:00.000Z");
  expect(pruned.deleted).toBe(1);
  expect(f.db.query("SELECT run_id,report FROM run_receipts ORDER BY run_id").all()).toEqual(pinned);
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  exportVault(f.db, f.vault, backup);
  restoreVault(backup, restored);
  const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
  try {
    expect(copy.query("SELECT * FROM extract_replay_receipts ORDER BY operation_id").all())
      .toEqual(f.db.query("SELECT * FROM extract_replay_receipts ORDER BY operation_id").all());
    expect(copy.query("SELECT * FROM extract_segment_settlements ORDER BY decision_id").all())
      .toEqual(f.db.query("SELECT * FROM extract_segment_settlements ORDER BY decision_id").all());
    expect(copy.query("SELECT * FROM extract_oversized_records").all()).toEqual(f.progress());
    expect(activeExtractReplay(copy, f.event.event_id, f.producer)).toEqual(completed === true ? null : { operation_id: f.child.operation_id, end_utf16: f.child.segment.done_utf16 });
  } finally { copy.close(); }
});

for (const label of ["missing-parent", "parent-hash", "cap", "source", "fork", "cycle", "settlement", "deleted-settlement", "run", "missing-run"] as const)
  test(`v2 restore rejects ${label} after archive rehash and publishes no partial vault`, async () => {
    const f = await fixture(); f.apply();
    const backup = join(f.root, "backup"), restored = join(f.root, "restored");
    exportVault(f.db, f.vault, backup);
    if (label === "settlement" || label === "deleted-settlement") {
      rewriteBackup(backup, "serve/extract-segment-settlements.jsonl", rows => label === "deleted-settlement" ? [] : rows.map(row => ({ ...row, decision_id: "f".repeat(64) })));
    } else if (label === "run" || label === "missing-run") {
      rewriteBackup(backup, "serve/extract-replay-runs.jsonl", rows => label === "missing-run" ? [] : rows.map(row => ({ ...row, report: String(row.report) + " " })));
    } else rewriteBackup(backup, "serve/extract-replay-receipts.jsonl", rows => {
      if (label === "missing-parent") return rows.filter(row => row.operation_id !== f.plan.operation_id);
      const child = rows.find(row => row.operation_id === f.child.operation_id)!;
      const plan = JSON.parse(String(child.plan));
      if (label === "parent-hash") plan.parent.plan_sha256 = "f".repeat(64);
      if (label === "cap") plan.segment.done_utf16++;
      if (label === "source") plan.source_key = "another-source";
      if (label === "cycle") plan.parent.operation_id = plan.operation_id;
      if (label === "fork") {
        plan.operation_id = "another-child";
        const encoded = canonicalJson(plan);
        return [...rows, { ...child, operation_id: plan.operation_id, plan: encoded, plan_sha256: sha256Hex(encoded) }];
      }
      const encoded = canonicalJson(plan);
      return rows.map(row => row === child ? { ...child, plan: encoded, plan_sha256: sha256Hex(encoded) } : row);
    });
    expect(() => restoreVault(backup, restored)).toThrow(/replay_conflict|historical_evidence_invalid|invalid_plan|FOREIGN KEY constraint/);
    expect(existsSync(restored)).toBe(false);
  });


test("replay evidence over the bounded journal retention budget refuses before file or DB mutation", async () => {
  const f = await fixture(); f.apply();
  const path = runReceiptsPath(f.vault), before = readFileSync(path, "utf8");
  f.db.query("UPDATE run_receipts SET report=? WHERE run_id=?").run("x".repeat(8 * 1024 * 1024 + 1), f.plan.old_run_id);
  const rows = f.db.query("SELECT run_id,length(report) AS bytes FROM run_receipts ORDER BY run_id").all();
  expect(() => pruneRunReceipts(f.db, f.vault, "2100-01-01T00:00:00.000Z")).toThrow("replay run receipts exceed journal retention bound");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(f.db.query("SELECT run_id,length(report) AS bytes FROM run_receipts ORDER BY run_id").all()).toEqual(rows);
});

test("v2 compares the current parent progress after evidence verification and refuses a stale snapshot", async () => {
  const f = await fixture();
  f.db.exec("UPDATE extract_oversized_records SET done_utf16=done_utf16+1");
  const before = f.progress();
  expect(() => f.apply()).toThrow("segment_changed");
  expect(f.progress()).toEqual(before);
  expect(f.db.query("SELECT * FROM extract_replay_receipts").all()).toHaveLength(1);
});

test("completed child lineage is validated even after its active link is cleared", async () => {
  const f = await fixture(); f.apply();
  writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=100000\n');
  await runRail(f.db, f.vault, "sync", { hooks: { producer: f.producer, claims: { db: f.db }, model_ref: MODEL } });
  expect(f.progress()).toMatchObject([{ replay_operation_id: null }]);
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  exportVault(f.db, f.vault, backup);
  rewriteBackup(backup, "serve/extract-replay-runs.jsonl", () => []);
  expect(() => restoreVault(backup, restored)).toThrow("historical_evidence_invalid");
  expect(existsSync(restored)).toBe(false);
});

test("v1 archives remain restorable without the later optional replay-run evidence stream", () => {
  const f = replayFixture(); fixtures.push(f);
  replayEmptyExtractSegment({ db: f.db, vault_path: f.vault, producer: f.producer }, f.plan);
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  exportVault(f.db, f.vault, backup);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  delete manifest.files["serve/extract-replay-runs.jsonl"];
  const { manifest_sha256: _old, ...unsigned } = manifest;
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({ ...unsigned, manifest_sha256: sha256Hex(JSON.stringify(unsigned, null, 2) + "\n") }, null, 2) + "\n");
  restoreVault(backup, restored);
  const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
  try { expect(copy.query("SELECT * FROM extract_replay_receipts").all()).toEqual(f.db.query("SELECT * FROM extract_replay_receipts").all()); }
  finally { copy.close(); }
});


test("V2 schema accessors cannot execute before closed-plan validation", async () => {
  const f = await fixture();
  let reads = 0;
  expect(() => f.apply({ ...f.child, get schema() { reads++; return f.child.schema; } })).toThrow("invalid_plan");
  expect(reads).toBe(0);
});
