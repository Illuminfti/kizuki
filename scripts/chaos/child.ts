import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCanonWrite, backupVault, correct, createBudgetTracker, createFts5RetrievalPort,
  exportVault, recoverCanonWrites, resolveTarget, restoreSnapshot, restoreVault,
  retryCanonProjectionObligations, runPurge, runServeDaemon, undoReceipt,
  rebuildRetrieval,
} from "../../packages/core/src";
import type { CanonIo } from "../../packages/core/src";
import { capture, fixtureClaims, ledger, MODEL, producer, readFixture } from "./fixture";
import { checkVault, InvariantFailure } from "./invariants";
import { tryRefreshDerived } from "../../packages/cli/src/derived";

const [mode, rootArgument, cut] = process.argv.slice(2);
if (!rootArgument || (mode !== "operate" && mode !== "recover")) throw new Error("invalid_child_arguments");
const root = rootArgument;
const fixture = readFixture(root);
const vault = join(root, "vault");
const db = ledger(vault);

type Acknowledgment = { kind: "event" | "receipt"; id: string } | { kind: "artifact"; target: "output" | "restored" };
function acknowledge(value: Acknowledgment): void {
  appendFileSync(join(root, "acknowledged.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
}

/** Only the deterministic regression waits here. Random trials add no write-path hooks. */
async function checkpoint(): Promise<void> {
  process.send?.({ event: "checkpoint" });
  await new Promise<void>(() => {});
}

async function operate(): Promise<void> {
  const io = { db, vault_path: vault };
  switch (fixture.operation) {
    case "capture":
      for (let record = 0; record < 128; record++) acknowledge({ kind: "event", id: capture(db, record) });
      break;
    case "extraction":
      await runServeDaemon(db, vault, { once: true, http: false, rails: ["sync"],
        hooks: { producer: producer(), model_ref: MODEL, claims: { db } }, log: () => {} });
      break;
    case "canon": {
      const port = cut === "projection-started" ? createFts5RetrievalPort({
        vault_path: vault, data_dir: join(vault, ".kizuki", "chaos-retrieval"), config: {},
        clock: () => new Date().toISOString(), logger: () => {}, secrets: async () => { throw new Error("fixture_has_no_secrets"); },
      }) : undefined;
      try {
        if (port) {
          const upsert = port.upsert.bind(port);
          port.upsert = async docs => { const result = await upsert(docs); await checkpoint(); return result; };
        }
        const target: CanonIo = { ...io, ...(port === undefined ? {} : { retrieval: port, retrieval_store: port.descriptor.id }) };
        for (const stored of fixtureClaims(db, fixture)) {
          const receipt = applyCanonWrite(target, stored, resolveTarget(target, stored), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
          await retryCanonProjectionObligations(target);
          acknowledge({ kind: "receipt", id: receipt.receipt_id });
        }
      } finally { await port?.close(); }
      break;
    }
    case "correction":
      for (const id of fixture.claimIds) {
        const result = await correct(io, { statement: "The researcher now works at Northwind.", target: { claim_id: id } });
        if (result.receipt_id !== null) acknowledge({ kind: "receipt", id: result.receipt_id });
      }
      break;
    case "undo":
      for (const id of fixture.receiptIds) acknowledge({ kind: "receipt", id: (await undoReceipt(io, id)).receipt_id });
      break;
    case "purge":
      await runPurge(db, vault, { connector_id: "chaos.target" }, "retire synthetic evidence");
      break;
    case "export": exportVault(db, vault, join(root, "output")); acknowledge({ kind: "artifact", target: "output" }); break;
    case "backup": await backupVault(db, vault, join(root, "output")); acknowledge({ kind: "artifact", target: "output" }); break;
    case "restore": restoreVault(join(root, "artifact"), join(root, "restored")); acknowledge({ kind: "artifact", target: "restored" }); break;
    case "restore-snapshot": restoreSnapshot(join(root, "artifact"), join(root, "restored")); acknowledge({ kind: "artifact", target: "restored" }); break;
    case "rebuild": await rebuildRetrieval(db, vault); break;
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
    const port = cut === "projection-started" ? createFts5RetrievalPort({
      vault_path: vault, data_dir: join(vault, ".kizuki", "chaos-retrieval"), config: {},
      clock: () => new Date().toISOString(), logger: () => {}, secrets: async () => { throw new Error("fixture_has_no_secrets"); },
    }) : undefined;
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
        hooks: { ...(fixture.operation === "extraction" ? { producer: producer(), model_ref: MODEL, claims: { db } }
          : port === undefined ? {} : { claims: { db, retrieval: port } }),
          // The public refresh seam catches a capture committed before its index update.
          refresh: async () => {
            const result = tryRefreshDerived(db, vault);
            return { indexed: result.events + result.pages, remaining: result.remaining, degraded: result.degraded };
          } },
        log: () => {} });
      if (recoveryFailure !== undefined) throw recoveryFailure;
      const acknowledgmentPath = join(root, "acknowledged.jsonl");
      if (existsSync(acknowledgmentPath)) {
        // The external observer can itself be killed mid-line; only complete acknowledgments count.
        for (const line of readFileSync(acknowledgmentPath, "utf8").split("\n").slice(0, -1)) {
          const acknowledgment = JSON.parse(line) as Acknowledgment;
          const present = acknowledgment.kind === "artifact" ? existsSync(join(root, acknowledgment.target))
            : db.query(`SELECT 1 FROM ${acknowledgment.kind === "event" ? "events WHERE event_id" : "canon_receipts WHERE receipt_id"}=?`).get(acknowledgment.id) !== null;
          if (!present) throw new InvariantFailure("acknowledged_work_lost");
        }
      }
      await checkVault(db, vault, fixture, true);
      if (fixture.operation === "restore" || fixture.operation === "restore-snapshot") {
        const restored = join(root, "restored");
        if (existsSync(restored)) {
          if (!existsSync(join(restored, ".kizuki", "kizuki.db"))) throw new InvariantFailure("restore_published_incomplete");
          const restoredDb = ledger(restored);
          try { await checkVault(restoredDb, restored, fixture, false); }
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
  process.stdout.write(JSON.stringify({ ok: false, reason }) + "\n");
  process.exitCode = 1;
} finally {
  db.close();
  if (process.connected) process.disconnect?.();
}
