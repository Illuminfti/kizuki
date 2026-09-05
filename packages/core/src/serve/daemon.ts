import type { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
import { initServe, listSchedules } from "./schema";
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

export interface ServeProcessMarker { pid: number; boot_id: string; instance_id: string; }
export function readServeProcessMarker(vaultPath: string): ServeProcessMarker | null {
  const path = servePidPath(vaultPath);
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4096) return null;
    const raw = readFileSync(fd, "utf8");
    if (raw.length > 4096) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if (Object.keys(marker).sort().join() !== "boot_id,instance_id,pid" || !Number.isSafeInteger(marker.pid) || Number(marker.pid) < 1 || typeof marker.boot_id !== "string" || !marker.boot_id || marker.boot_id.length > 128 || typeof marker.instance_id !== "string" || !marker.instance_id || marker.instance_id.length > 128) return null;
    return marker as unknown as ServeProcessMarker;
  } finally { closeSync(fd); }
}
export function readServePid(vaultPath: string): number | null {
  const marker = readServeProcessMarker(vaultPath);
  if (marker) return marker.pid;
  const path = servePidPath(vaultPath);
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4096) return null;
    const raw = readFileSync(fd, "utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
  } finally { closeSync(fd); }
}
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

export async function runServeDaemon(
  db: Database,
  vaultPath: string,
  options: ServeDaemonOptions = {},
): Promise<{ receipts: number; http: ServeHttpHandle | null }> {
  initServe(db);
  const recovered = recoverRunJournal(db, vaultPath);
  const process = options.process ?? thisProcess(options.now);
  const instanceId = crypto.randomUUID();
  const acquired = acquireLease(db, process);
  if (!acquired.acquired) {
    throw new ServeDaemonError("lease_busy", "writer lease is held by a live process");
  }
  let http: ServeHttpHandle | null = null;
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
  writePid(vaultPath, { pid: process.pid, boot_id: process.boot_id, instance_id: instanceId });
  const config = loadServeConfig(vaultPath);
  const httpEnabled = options.http ?? config.http;
  if (httpEnabled) {
    http = startServeHttp({
      db,
      vaultPath,
      host: config.bind_host,
      port: options.port ?? config.bind_port,
      ...(options.hooks?.claims?.retrieval === undefined ? {} : { retrieval: options.hooks.claims.retrieval }),
    });
  }


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
        if (stopping) break;
        if (!isRailId(rail)) continue;
        await runRail(db, vaultPath, rail, {
          now: process.now,
          execution: { instance_id: instanceId, pid: process.pid, boot_id: process.boot_id, trigger: "once", due_at: null },
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
          execution: { instance_id: instanceId, pid: process.pid, boot_id: process.boot_id, trigger: "scheduled",
            due_at: listSchedules(db).find(row => row.rail === rail)?.next_run_at ?? process.now() },
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
    try { if (http !== null) await http.stop(); }
    finally {
      try { clearPid(vaultPath, instanceId); }
      finally { releaseLease(db, process); }
    }
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
