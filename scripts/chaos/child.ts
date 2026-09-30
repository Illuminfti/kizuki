import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCanonWrite, backupVault, correct, createBudgetTracker,
  exportVault, getCanonReceiptRecord, recoverCanonWrites, resolveTarget, restoreSnapshot, restoreVault,
  retryCanonProjectionObligations, runPurge, runServeDaemon, undoReceipt,
  rebuildRetrieval,
} from "../../packages/core/src";
import type { CanonIo } from "../../packages/core/src";
import { capture, fixtureClaims, ledger, MODEL, producer, readFixture, retrieval } from "./fixture";
import { checkVault, InvariantFailure, retrievalProjection } from "./invariants";
import { tryRefreshDerived } from "../../packages/cli/src/derived";
import { worldCanonTarget } from "../../packages/core/src/canon/world-materialization";
import { journalExtractBatch, mineLiveDrafts } from "../../packages/core/src/serve/extract";
import { setPurgeRecoveryHook } from "../../packages/core/src/ledger/purge";
import { isDeepStrictEqual } from "node:util";

const [mode, rootArgument, cut] = process.argv.slice(2);
if (!rootArgument || (mode !== "operate" && mode !== "recover")) throw new Error("invalid_child_arguments");
const root = rootArgument;
const fixture = readFixture(root);
const vault = join(root, "vault");
const db = ledger(vault);
const extractionProducer = producer();
const produce = extractionProducer.produce.bind(extractionProducer);
extractionProducer.produce = async input => {
  appendFileSync(join(root, "producer-inputs.jsonl"), JSON.stringify(input.events.map(event => event.event_id)) + "\n", { mode: 0o600 });
  return produce(input);
};

type Acknowledgment = { kind: "event" | "receipt"; id: string } | { kind: "artifact"; target: "output" | "restored" };
async function acknowledge(value: Acknowledgment): Promise<void> {
  const records = value.kind === "artifact" ? [] : value.kind === "event"
    ? [{ table: "events", key: "event_id", id: value.id, row: db.query("SELECT * FROM events WHERE event_id=?").get(value.id) }]
    : (getCanonReceiptRecord(db, value.id) as { claim_ids: string[] }).claim_ids.map(id => ({
      table: "claims", key: "claim_id", id, row: db.query("SELECT * FROM claims WHERE claim_id=?").get(id),
    }));
  appendFileSync(join(root, "acknowledged.jsonl"), JSON.stringify({ ...value, records }) + "\n", { mode: 0o600 });
  if (cut === "acknowledged") await checkpoint();
}

function begin(claims: string[], receipts: string[] = []): void {
  // Only targets whose call has begun may differ; later calls' baseline stays protected.
  appendFileSync(join(root, "begun.jsonl"), JSON.stringify({ claims, receipts }) + "\n", { mode: 0o600 });
}

/** Only deterministic boundary regressions wait here. Random trials add no write-path hooks. */
async function checkpoint(): Promise<void> {
  process.send?.({ event: "checkpoint" });
  await new Promise<void>(() => {});
}

async function operate(): Promise<void> {
  const io = { db, vault_path: vault };
  switch (fixture.operation) {
    case "capture":
      for (let record = 0; record < 128; record++) await acknowledge({ kind: "event", id: capture(db, record) });
      break;
    case "extraction":
      if (cut === "extraction-journaled") {
        const mined = await mineLiveDrafts(db, extractionProducer);
        if (!journalExtractBatch(db, mined, MODEL, extractionProducer).journaled) throw new Error("fixture_decision_not_journaled");
        writeFileSync(join(root, "journaled-inputs.json"), JSON.stringify({
          inputs: mined.model_inputs?.map(input => input.event_id) ?? mined.input_ids,
          drafts: mined.drafts,
        }), { mode: 0o600 });
        await checkpoint();
      }
      await runServeDaemon(db, vault, { once: true, http: false, rails: ["sync"],
        hooks: { producer: extractionProducer, model_ref: MODEL, claims: { db } }, log: () => {} });
      break;
    case "canon": case "typed-canon": {
      const port = cut === "projection-started" ? retrieval(vault) : undefined;
      try {
        if (port) {
          const upsert = port.upsert.bind(port);
          port.upsert = async docs => { const result = await upsert(docs); await checkpoint(); return result; };
        }
        const target: CanonIo = { ...io, ...(port === undefined ? {} : { retrieval: port, retrieval_store: port.descriptor.id }) };
        for (const stored of fixtureClaims(db, fixture)) {
          begin([stored.claim_id]);
          const decision = fixture.operation === "typed-canon" ? worldCanonTarget(db, stored.claim_id) : resolveTarget(target, stored);
          const receipt = applyCanonWrite(target, stored, decision, { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
          await retryCanonProjectionObligations(target);
          await acknowledge({ kind: "receipt", id: receipt.receipt_id });
        }
      } finally { await port?.close(); }
      break;
    }
    case "correction": case "typed-correction":
      for (const id of fixture.claimIds) {
        const previous = fixture.baseline.claims.find(row => row.claim_id === id)?.receipt_id;
        begin([id], typeof previous === "string" ? [previous] : []);
        const result = await correct(io, { statement: "The researcher now works at Northwind.", target: { claim_id: id } });
        if (result.receipt_id !== null) await acknowledge({ kind: "receipt", id: result.receipt_id });
      }
      break;
    case "undo": case "typed-undo":
      for (const id of fixture.receiptIds) {
        const previous = getCanonReceiptRecord(db, id) as { claim_ids: string[] };
        begin(previous.claim_ids, [id]);
        await acknowledge({ kind: "receipt", id: (await undoReceipt(io, id)).receipt_id });
      }
      break;
    case "purge": case "typed-purge":
      begin(fixture.claimIds, fixture.receiptIds);
      if (cut === "purge-admitted") setPurgeRecoveryHook(stage => {
        if (stage !== "phase-one-committed") return;
        writeFileSync(join(root, "checkpoint"), stage, { mode: 0o600 });
        // Freeze inside the synchronous writer scope until the parent delivers SIGKILL.
        process.kill(process.pid, "SIGSTOP");
      });
      await runPurge(db, vault, { connector_id: "chaos.target" }, "retire synthetic evidence");
      break;
    case "export": exportVault(db, vault, join(root, "output")); await acknowledge({ kind: "artifact", target: "output" }); break;
    case "backup": await backupVault(db, vault, join(root, "output")); await acknowledge({ kind: "artifact", target: "output" }); break;
    case "restore": restoreVault(join(root, "artifact"), join(root, "restored")); await acknowledge({ kind: "artifact", target: "restored" }); break;
    case "restore-snapshot": restoreSnapshot(join(root, "artifact"), join(root, "restored")); await acknowledge({ kind: "artifact", target: "restored" }); break;
    case "rebuild": await rebuildRetrieval(db, vault); break;
    case "retrieval-rebuild": {
      const port = retrieval(vault);
      try { await rebuildRetrieval(db, vault, port); }
      finally { await port.close(); }
      break;
    }
  }
}

try {
  if (mode === "operate") {
    await new Promise<void>(resolve => {
      process.once("message", message => { if (message === "start") resolve(); });
      process.send?.({ event: "ready" });
    });
    process.send?.({ event: "started" });
    await operate();
    writeFileSync(join(root, "operation-completed"), "complete\n", { mode: 0o600 });
    process.send?.({ event: "completed" });
  } else {
    const port = cut === "projection-started" || fixture.operation === "retrieval-rebuild" ? retrieval(vault) : undefined;
    try {
      const io = { db, vault_path: vault, ...(port === undefined ? {} : { retrieval: port }) };
      let recoveryFailure: unknown;
      try {
        recoverCanonWrites(io);
        await retryCanonProjectionObligations(io);
      } catch (error) { recoveryFailure = error; }
      // Startup and one pass still run when canon recovery is held.
      await runServeDaemon(db, vault, { once: true, http: false, rails: ["sync", "retrieval-sweep", "purge-sweep", "doctor-sweep"],
        // Exercise the real dead-PID reclaim rule without sleeping through its heartbeat grace.
        now: () => new Date(Date.now() + 31_000).toISOString(),
        hooks: { ...(fixture.operation === "extraction" ? { producer: extractionProducer, model_ref: MODEL, claims: { db } }
          : port === undefined ? {} : { claims: { db, retrieval: port } }),
          // The public refresh seam catches a capture committed before its index update.
          refresh: async () => {
            const result = tryRefreshDerived(db, vault);
            return { indexed: result.events + result.pages, remaining: result.remaining, degraded: result.degraded };
          } },
        log: () => {} });
      if (recoveryFailure !== undefined) throw recoveryFailure;
      const journaledPath = join(root, "journaled-inputs.json");
      if (existsSync(journaledPath)) {
        const { inputs, drafts } = JSON.parse(readFileSync(journaledPath, "utf8")) as {
          inputs: string[];
          drafts: { subject: string; predicate: string; object: string; body: string; event_ids: string[] }[];
        };
        const calls = readFileSync(join(root, "producer-inputs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
        if (inputs.some(id => calls.filter(call => call.includes(id)).length !== 1)) throw new InvariantFailure("journaled_input_reextracted");
        for (const draft of drafts) {
          const claims = db.query<{ provenance: string }, [string, string, string, string]>("SELECT provenance FROM claims WHERE subject=? AND predicate=? AND object=? AND body=?")
            .all(draft.subject, draft.predicate, draft.object, draft.body);
          if (!claims.some(claim => JSON.stringify(JSON.parse(claim.provenance)) === JSON.stringify(draft.event_ids))) throw new InvariantFailure("journaled_claim_lost");
        }
      }
      const acknowledgmentPath = join(root, "acknowledged.jsonl");
      if (existsSync(acknowledgmentPath)) {
        // The external observer can itself be killed mid-line; only complete acknowledgments count.
        for (const line of readFileSync(acknowledgmentPath, "utf8").split("\n").slice(0, -1)) {
          const acknowledgment = JSON.parse(line) as Acknowledgment & {
            records: { table: string; key: string; id: string; row: unknown }[];
          };
          const present = acknowledgment.kind === "artifact" ? existsSync(join(root, acknowledgment.target))
            : db.query(`SELECT 1 FROM ${acknowledgment.kind === "event" ? "events WHERE event_id" : "canon_receipts WHERE receipt_id"}=?`).get(acknowledgment.id) !== null;
          if (!present) throw new InvariantFailure("acknowledged_work_lost");
          for (const record of acknowledgment.records) {
            if (!isDeepStrictEqual(db.query(`SELECT * FROM ${record.table} WHERE ${record.key}=?`).get(record.id), record.row)) throw new InvariantFailure("acknowledged_record_changed");
          }
        }
      }
      const begunPath = join(root, "begun.jsonl");
      const begun = existsSync(begunPath) ? readFileSync(begunPath, "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line) as NonNullable<typeof fixture.activeTargets>) : [];
      fixture.activeTargets = { claims: begun.flatMap(value => value.claims), receipts: begun.flatMap(value => value.receipts) };
      await checkVault(db, vault, fixture);
      if (fixture.operation === "retrieval-rebuild" && port !== undefined) {
        if ((await port.health()).status !== "ready") throw new InvariantFailure("retrieval_health");
        const before = await retrievalProjection(port);
        if (before !== fixture.retrievalProjection) throw new InvariantFailure("committed_retrieval_changed");
        await rebuildRetrieval(db, vault, port);
        if (await retrievalProjection(port) !== before) throw new InvariantFailure("retrieval_rebuild_not_equal");
      }
      const output = join(root, "output");
      if ((fixture.operation === "export" || fixture.operation === "backup") && existsSync(output)) {
        const validated = join(root, "validated-output");
        if (fixture.operation === "export") restoreVault(output, validated);
        else restoreSnapshot(output, validated);
        const validatedDb = ledger(validated);
        try { await checkVault(validatedDb, validated, fixture, fixture.operation === "export"); }
        finally { validatedDb.close(); }
      }
      if (fixture.operation === "restore" || fixture.operation === "restore-snapshot") {
        const restored = join(root, "restored");
        if (existsSync(restored)) {
          if (!existsSync(join(restored, ".kizuki", "kizuki.db"))) throw new InvariantFailure("restore_published_incomplete");
          const restoredDb = ledger(restored);
          try { await checkVault(restoredDb, restored, fixture, fixture.operation === "restore"); }
          finally { restoredDb.close(); }
        }
      }
      process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    } finally { await port?.close(); }
  }
} catch (error) {
  // Diagnostics contain only a fixed code. Synthetic failure artifacts remain local.
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  const reason = error instanceof InvariantFailure ? error.message : typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "operation_refused";
  writeFileSync(join(root, "recovery-diagnostics.txt"), error instanceof Error ? error.stack ?? error.message : "unknown failure", { mode: 0o600 });
  if (error instanceof InvariantFailure && error.detail !== undefined) writeFileSync(join(root, "invariant-diagnostics.json"), JSON.stringify(error.detail), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: false, reason }) + "\n");
  process.exitCode = 1;
} finally {
  db.close();
  if (process.connected) process.disconnect?.();
}
