import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nodeProcess from "node:process";
import { loadServeConfig } from "./config";
import { startServeHttp } from "./http";
import type { ServeHttpHandle } from "./http";
import {
  acquireLease,
  heartbeatLease,
  releaseLease,
  thisProcess,
  type LeaseProcess,
} from "./leases";
import { recoverRunJournal } from "./receipts";
import { dueRails, runRail, type RailHooks } from "./rails";
import { initServe } from "./schema";
import { SERVE_PID_PATH, ServeDaemonError, isRailId, type CrashPoint, type RailId } from "./types";

export interface ServeDaemonOptions {
  readonly now?: () => string;
  readonly hooks?: RailHooks;
  readonly crashAfter?: CrashPoint;
  readonly http?: boolean;
  readonly port?: number;
  readonly once?: boolean;
  readonly rails?: RailId[];
  readonly process?: LeaseProcess;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly shouldContinue?: () => boolean;
}

export interface ServeStatus {
  readonly pid: number | null;
  readonly running: boolean;
  readonly lease: "held" | "free" | "busy";
  readonly http: { host: string; port: number } | null;
}

export function servePidPath(vaultPath: string): string {
  return join(vaultPath, SERVE_PID_PATH);
}

export function readServePid(vaultPath: string): number | null {
  const path = servePidPath(vaultPath);
  if (!existsSync(path)) return null;
  const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function writePid(vaultPath: string, pid: number): void {
  const path = servePidPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
}

function clearPid(vaultPath: string): void {
  const path = servePidPath(vaultPath);
  if (existsSync(path)) unlinkSync(path);
}

export async function runServeDaemon(
  db: Database,
  vaultPath: string,
  options: ServeDaemonOptions = {},
): Promise<{ receipts: number; http: ServeHttpHandle | null }> {
  initServe(db);
  const recovered = recoverRunJournal(db, vaultPath);
  const process = options.process ?? thisProcess(options.now);
  const acquired = acquireLease(db, process);
  if (!acquired.acquired) {
    throw new ServeDaemonError("lease_busy", "writer lease is held by a live process");
  }
  writePid(vaultPath, process.pid);
  const config = loadServeConfig(vaultPath);
  const httpEnabled = options.http ?? config.http;
  let http: ServeHttpHandle | null = null;
  if (httpEnabled) {
    http = startServeHttp({
      db,
      vaultPath,
      host: config.bind_host,
      port: options.port ?? config.bind_port,
    });
  }

  let receipts = recovered.length;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // SIGTERM is the public stop mechanism.  Consume it here so an in-flight
  // receipted write can reach its durable boundary, then leave the loop and
  // release the writer lease/PID in the finally block below.
  let stopping = false;
  const requestStop = (): void => { stopping = true; };
  nodeProcess.once("SIGTERM", requestStop);
  nodeProcess.once("SIGINT", requestStop);
  try {
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
        if (!isRailId(rail)) continue;
        await runRail(db, vaultPath, rail, {
          now: process.now,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.crashAfter === undefined ? {} : { crashAfter: options.crashAfter }),
        });
        receipts += 1;
      }
      return { receipts, http };
    }

    while (!stopping && (options.shouldContinue?.() ?? true)) {
      heartbeatLease(db, process);
      const due = dueRails(db, process.now());
      const rail = due[0];
      if (rail !== undefined) {
        await runRail(db, vaultPath, rail, {
          now: process.now,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
        });
        receipts += 1;
        continue;
      }
      await sleep(1_000);
      if (stopping || (options.shouldContinue !== undefined && !options.shouldContinue())) break;
    }
    return { receipts, http };
  } finally {
    nodeProcess.off("SIGTERM", requestStop);
    nodeProcess.off("SIGINT", requestStop);
    if (http !== null) await http.stop();
    releaseLease(db, process);
    clearPid(vaultPath);
  }
}

export function serveStatus(
  db: Database,
  vaultPath: string,
  process: LeaseProcess = thisProcess(),
): ServeStatus {
  const pid = readServePid(vaultPath);
  const lease = acquireLease(db, process);
  if (lease.acquired) {
    releaseLease(db, process);
  }
  return {
    pid,
    running: pid !== null && process.isAlive(pid),
    lease: lease.reason === "busy" ? "busy" : lease.acquired ? "free" : "free",
    http: null,
  };
}
