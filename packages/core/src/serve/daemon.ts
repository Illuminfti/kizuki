import type { Database } from "bun:sqlite";
import { recoverCanonWrites } from "../canon/recovery";
import { CanonRecoveryError, inspectCanonRecovery } from "../canon/write-intent";
import { canonRecoveryNextStep, readCanonRecoveryHold } from "../canon/stage-recovery";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nodeProcess from "node:process";
import { LEDGER_LOOP_PROBE_TIMEOUT_MS } from "../ledger/limits";
import { retryWhileBusy, withControlWait } from "../ledger/busy";
import { embedBackfillPeriod, loadServeConfig } from "./config";
import { clearServeEndpoint, writeServeEndpoint } from "./endpoint";
import { startServeHttp } from "./http";
import type { ServeHttpHandle } from "./http";
import { asLeaseHeld, ledgerLeaseHolder } from "./lease-held";
import {
  acquireLease,
  heartbeatLease,
  leaseState,
  releaseLease,
  thisProcess,
  type LeaseProcess,
  type LeaseState,
} from "./leases";
import { getRunReceipt, recoverRunJournal } from "./receipts";
import { dueRails, runRail, type RailHooks, type RailHooksV2, type RailRuntime, type RailRuntimeContext, type RailRuntimeV2 } from "./rails";
import type { RetrievalPort } from "../contracts/retrieval";
import { applyRailPeriod, initServe, listSchedules } from "./schema";
import {
  LEDGER_HELD_BACKOFF_MAX_MS,
  LEDGER_HELD_BACKOFF_MIN_MS,
  LEDGER_LEASE_HELD_STOP,
  STOP_WATCH_MS,
  ServeDaemonError,
  isRailId,
  type CrashPoint,
  type RailId,
  type RunExecution,
  type RunReceipt,
} from "./types";
import { readServePid, readServeProcessMarker, servePidPath, type ServeProcessMarker } from "./process-marker";
import { clearServeStopRequest, serveStopRequested } from "./stop-control";

interface ServeDaemonOptionsBase {
  readonly now?: () => string;
  /** HTTP owns no per-rail runtime; this port belongs to the daemon's caller. */
  readonly retrieval?: RetrievalPort;
  readonly crashAfter?: CrashPoint;
  readonly http?: boolean;
  readonly port?: number;
  readonly once?: boolean;
  readonly rails?: RailId[];
  readonly process?: LeaseProcess;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly shouldContinue?: () => boolean;
  /** One structured line per held recovery attempt; defaults to stderr. */
  readonly log?: (line: string) => void;
  /** Terminal command cancellation, including startup and final cleanup. */
  readonly signal?: AbortSignal;
  /** Startup finished; subsequent contention must never restart this invocation. */
  readonly onStarted?: () => void;
}

export interface ServeDaemonOptions extends ServeDaemonOptionsBase {
  readonly hooks?: RailHooks;
  readonly acquireRuntime?: (context: RailRuntimeContext) => Promise<RailRuntime>;
}

export interface ServeDaemonOptionsV2 extends ServeDaemonOptionsBase {
  readonly hooks?: RailHooksV2;
  readonly acquireRuntime?: (context: RailRuntimeContext) => Promise<RailRuntimeV2>;
}

type AnyServeDaemonOptions = ServeDaemonOptions | ServeDaemonOptionsV2;

export interface ServeStatus {
  readonly pid: number | null;
  readonly running: boolean;
  readonly lease: LeaseState;
  readonly http: { host: string; port: number } | null;
}

export { readServePid, readServeProcessMarker, servePidPath, type ServeProcessMarker } from "./process-marker";

function syncPidDirectory(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writePid(vaultPath: string, marker: ServeProcessMarker): void {
  const path = servePidPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(marker) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); syncPidDirectory(path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function clearPid(vaultPath: string, instanceId: string): void {
  if (readServeProcessMarker(vaultPath)?.instance_id !== instanceId) return;
  const path = servePidPath(vaultPath);
  unlinkSync(path); syncPidDirectory(path);
}

export function runServeDaemon(
  db: Database,
  vaultPath: string,
  options?: ServeDaemonOptions,
): Promise<{ receipts: number; http: ServeHttpHandle | null }>;
export function runServeDaemon(
  db: Database,
  vaultPath: string,
  options: ServeDaemonOptionsV2,
): Promise<{ receipts: number; http: ServeHttpHandle | null }>;
export async function runServeDaemon(
  db: Database,
  vaultPath: string,
  options: AnyServeDaemonOptions = {},
): Promise<{ receipts: number; http: ServeHttpHandle | null }> {
  if (options.hooks !== undefined && options.acquireRuntime !== undefined) {
    throw new ServeDaemonError("runtime_options_conflict", "rail hooks and acquireRuntime are mutually exclusive");
  }
  initServe(db);
  const recovered = recoverRunJournal(db, vaultPath);
  const process = options.process ?? thisProcess(options.now);
  const instanceId = crypto.randomUUID();
  const ownMarker = { pid: process.pid, boot_id: process.boot_id, instance_id: instanceId };
  const acquired = acquireLease(db, process);
  if (!acquired.acquired) {
    throw new ServeDaemonError("lease_busy", "writer lease is held by a live process");
  }
  let http: ServeHttpHandle | null = null;
  let receipts = recovered.length;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Native supervisor signals and instance-bound CLI requests leave an active
  // rail at its durable boundary, then release the runtime, marker and lease.
  let stopping = false;
  // A model request in flight is aborted, not waited out: a stop must finish
  // inside the supervisor's stop timeout whatever the model timeout is.
  const stopSignal = new AbortController();
  const priorWait = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    // The connector has the only remaining operation deadline. Every later
    // batch write, receipt publication and lease release tries without waiting;
    // uncommitted work replays and the receipt journal survives a busy ledger.
    db.exec("PRAGMA busy_timeout=0");
    stopSignal.abort();
  };
  options.signal?.addEventListener("abort", requestStop, { once: true });
  if (options.signal?.aborted) requestStop();
  // A long sync pass reads the same request before each extraction step.
  const stopRequested = (): boolean => stopping || serveStopRequested(vaultPath, ownMarker);
  const log = options.log ?? ((line: string) => { nodeProcess.stderr.write(`${line}\n`); });
  // A queued `serve stop` is a file, so a rail in flight has to be told.
  const runRailUntilStopped = async (rail: RailId, execution: RunExecution, ledgerHeld = false): Promise<RunReceipt> => {
    const watch = setInterval(() => { if (stopRequested()) requestStop(); }, STOP_WATCH_MS);
    try {
      return await runRail(db, vaultPath, rail, {
        ...options,
        now: process.now,
        stopRequested,
        signal: stopSignal.signal,
        ledgerHeld,
        execution,
      });
    } finally { clearInterval(watch); }
  };
  // Sleep in slices so a stop request ends a backoff at the next slice.
  const backoff = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0 && !stopRequested(); left -= 1_000) await sleep(Math.min(1_000, left));
  };
  nodeProcess.once("SIGTERM", requestStop);
  nodeProcess.once("SIGINT", requestStop);
  try {
  writePid(vaultPath, ownMarker);
  if (inspectCanonRecovery(db).pending) {
    try { recoverCanonWrites({ db, vault_path: vaultPath }); }
    catch (error) {
      // Writer-held mode: the durable hold stays visible to doctor and the
      // serving boundary, reads and ingest keep running, and the supervisor
      // is never asked to restart into the same refusal.
      if (!(error instanceof CanonRecoveryError)) throw error;
      log(canonRecoveryHeldLine(vaultPath, error));
    }
  }
  const config = loadServeConfig(vaultPath);
  // The journal is replayed and the lease held, so no pending receipt still
  // expects the old period.
  applyRailPeriod(db, "sync", config.sync_period_s, process.now());
  applyRailPeriod(db, "embed-backfill", embedBackfillPeriod(vaultPath), process.now());
  const httpEnabled = options.http ?? config.http;
  if (httpEnabled) {
    const retrieval = options.retrieval ?? options.hooks?.claims?.retrieval;
    http = startServeHttp({
      db,
      vaultPath,
      host: config.bind_host,
      port: options.port ?? config.bind_port,
      ...(retrieval === undefined ? {} : { retrieval }),
    });
    try {
      writeServeEndpoint(vaultPath, { host: http.host, port: http.port, instance_id: ownMarker.instance_id });
    } catch {
      // The endpoint file is only a discovery hint for local clients; sync and http stay up without it.
      log("serve: endpoint hint could not be written; clients must find the daemon another way");
    }
  }
  options.onStarted?.();
    if (options.once === true) {
      const rails =
        options.rails ??
        (dueRails(db, process.now()).length > 0
          ? dueRails(db, process.now())
          : undefined);
      const listed = rails ?? [
        "sync",
        "retrieval-sweep",
        "purge-sweep",
        "embed-backfill",
        "brief",
        "doctor-sweep",
        "journal-prune",
      ];
      for (const rail of listed) {
        if (stopRequested()) break;
        if (!isRailId(rail)) continue;
        const receipt = await runRailUntilStopped(rail, { instance_id: instanceId, pid: process.pid, boot_id: process.boot_id, trigger: "once", due_at: null });
        if (getRunReceipt(db, receipt.run_id) !== null) receipts += 1;
      }
      return { receipts, http };
    }

    // A held ledger skips passes; it never ends the daemon. Consecutive
    // skips lengthen the wait until a pass runs again, and that says so.
    let held = 0;
    // A receipt whose journal line outlived a refused ledger write must reach
    // the ledger before any rail runs again, or the same slot would run twice.
    let unpublished = false;
    const skipped = async (): Promise<void> => {
      held += 1;
      if (held === 1) log(ledgerHeldLine(vaultPath, db, "held"));
      await backoff(Math.min(LEDGER_HELD_BACKOFF_MIN_MS * 2 ** (held - 1), LEDGER_HELD_BACKOFF_MAX_MS));
    };
    const writable = (): void => {
      if (held === 0) return;
      held = 0;
      log(ledgerHeldLine(vaultPath, db, "free"));
    };
    while (!stopRequested() && (options.shouldContinue?.() ?? true)) {
      try {
        // The probe waits briefly: the loop shares a thread with loopback HTTP.
        let free = true;
        try { withControlWait(db, () => heartbeatLease(db, process), LEDGER_LOOP_PROBE_TIMEOUT_MS); }
        catch (error) { if (asLeaseHeld(vaultPath, error, db) === null) throw error; free = false; }
        if (free && unpublished) { recoverRunJournal(db, vaultPath); unpublished = false; }
        const rail = dueRails(db, process.now())[0];
        if (rail !== undefined) {
          // A rail due while the ledger is held records its skipped pass, so doctor sees it.
          const receipt = await runRailUntilStopped(rail, { instance_id: instanceId, pid: process.pid, boot_id: process.boot_id, trigger: "scheduled",
            due_at: listSchedules(db).find(row => row.rail === rail)?.next_run_at ?? process.now() }, !free);
          // A coalesced idle run advances the schedule and persists no receipt.
          if (getRunReceipt(db, receipt.run_id) !== null) receipts += 1;
          if (receipt.stopped === LEDGER_LEASE_HELD_STOP) await skipped();
          else writable();
          continue;
        }
        if (!free) { await skipped(); continue; }
        writable();
        await sleep(1_000);
        if (stopping || (options.shouldContinue !== undefined && !options.shouldContinue())) break;
      } catch (error) {
        if (asLeaseHeld(vaultPath, error, db) === null) throw error;
        unpublished = true;
        await skipped();
      }
    }
    return { receipts, http };
  } catch (error) {
    // A stop queued against the startup marker is terminal too. Observe it
    // before cleanup removes the marker/request, or a busy startup could be
    // mistaken for another attempt after the requested shutdown.
    if (asLeaseHeld(vaultPath, error, db) !== null && stopRequested()) return { receipts, http };
    throw error;
  } finally {
    if (stopRequested()) requestStop();
    options.signal?.removeEventListener("abort", requestStop);
    nodeProcess.off("SIGTERM", requestStop);
    nodeProcess.off("SIGINT", requestStop);
    try { if (http !== null) { clearServeEndpoint(vaultPath); await http.stop(); } }
    finally {
      try { clearServeStopRequest(vaultPath, ownMarker); clearPid(vaultPath, instanceId); }
      finally {
        // A writer that outlasts the retries leaves the lease to expire: its
        // holder is dead, so the next start reclaims it after the stale window.
        try {
          try { retryWhileBusy(() => releaseLease(db, process), stopping ? 1 : RELEASE_ATTEMPTS); }
          catch (error) { if (asLeaseHeld(vaultPath, error) === null) throw error; }
        } finally { if (priorWait !== undefined) db.exec(`PRAGMA busy_timeout=${priorWait}`); }
      }
    }
  }
}

/** Ordinary cleanup retries release; requested shutdown uses one nonblocking attempt. */
const RELEASE_ATTEMPTS = 2;

/** One structured line when the ledger is held by another writer, and one when the daemon can write again. */
function ledgerHeldLine(vaultPath: string, db: Database, state: "held" | "free"): string {
  const holder = state === "held" ? ledgerLeaseHolder(vaultPath, db, process.pid) : null;
  return JSON.stringify({
    event: `ledger_${state}`,
    ...(holder === null ? {} : { holder_pid: holder.pid, holder: holder.kind }),
    next: state === "held" ? "rails skip their passes and retry with backoff; nothing is lost" : "rails resume",
  });
}

function canonRecoveryHeldLine(vaultPath: string, error: CanonRecoveryError): string {
  const hold = readCanonRecoveryHold(vaultPath);
  return JSON.stringify({
    event: "canon_recovery_held", mode: "writer-held", reason: error.reason, receipt_id: error.receipt_id,
    attempts: hold !== null && hold.receipt_id === error.receipt_id ? hold.attempts : 1,
    next: canonRecoveryNextStep(error.reason, [], error.receipt_id),
  });
}

export function serveStatus(
  db: Database,
  vaultPath: string,
  process: LeaseProcess = thisProcess(),
): ServeStatus {
  const pid = readServePid(vaultPath);
  return {
    pid,
    running: pid !== null && process.isAlive(pid),
    lease: leaseState(db, process),
    http: null,
  };
}
