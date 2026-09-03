import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { tableExists } from "../ledger/schema";
import {
  HEARTBEAT_SECONDS,
  LEASE_RECLAIM_HEARTBEATS,
  ServeDaemonError,
  WRITER_LEASE,
  type LeaseRow,
} from "./types";

export interface LeaseProcess {
  readonly pid: number;
  readonly boot_id: string;
  readonly now: () => string;
  readonly isAlive: (pid: number) => boolean;
}

export interface LeaseAcquireResult {
  readonly acquired: boolean;
  readonly lease: LeaseRow | null;
  readonly reason: "acquired" | "busy" | "reclaimed" | "missing-table";
}

function rowOf(
  row: {
    name: string;
    holder_pid: number;
    holder_boot_id: string;
    acquired_at: string;
    heartbeat_at: string;
    ttl_s: number;
  } | null,
): LeaseRow | null {
  if (row === null) return null;
  return {
    name: row.name,
    holder_pid: row.holder_pid,
    holder_boot_id: row.holder_boot_id,
    acquired_at: row.acquired_at,
    heartbeat_at: row.heartbeat_at,
    ttl_s: row.ttl_s,
  };
}

export function readLease(db: Database, name: string): LeaseRow | null {
  if (!tableExists(db, "leases")) return null;
  return rowOf(
    db
      .query<
        {
          name: string;
          holder_pid: number;
          holder_boot_id: string;
          acquired_at: string;
          heartbeat_at: string;
          ttl_s: number;
        },
        [string]
      >(
        `SELECT name, holder_pid, holder_boot_id, acquired_at, heartbeat_at, ttl_s
           FROM leases WHERE name = ?`,
      )
      .get(name),
  );
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readBootId(): string {
  try {
    const trimmed = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // macOS and test hosts have no proc boot id.
  }
  return `pid:${process.pid}`;
}

function ageSeconds(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 1000);
}

function isBusy(lease: LeaseRow, process: LeaseProcess, now: string): boolean {
  if (lease.holder_pid === process.pid && lease.holder_boot_id === process.boot_id) {
    return false;
  }
  // RFC 0002 §11.3: a live holder PID is BUSY. boot_id distinguishes a
  // post-reboot reuse of the same number; a still-alive PID is never stolen.
  if (process.isAlive(lease.holder_pid)) return true;
  const staleAfter = HEARTBEAT_SECONDS * LEASE_RECLAIM_HEARTBEATS;
  return ageSeconds(lease.heartbeat_at, now) < staleAfter;
}

export function reclaimDeadLease(
  db: Database,
  name: string,
  process: LeaseProcess,
): LeaseRow | null {
  const existing = readLease(db, name);
  if (existing === null) return null;
  const now = process.now();
  if (isBusy(existing, process, now)) {
    throw new ServeDaemonError("lease_busy", "a live holder lease is never stolen");
  }
  if (process.isAlive(existing.holder_pid) && existing.holder_boot_id === process.boot_id) {
    return null;
  }
  db.query("DELETE FROM leases WHERE name = ?").run(name);
  return existing;
}

export function acquireLease(
  db: Database,
  process: LeaseProcess,
  name = WRITER_LEASE,
  ttl_s = HEARTBEAT_SECONDS * LEASE_RECLAIM_HEARTBEATS,
): LeaseAcquireResult {
  if (!tableExists(db, "leases")) {
    return { acquired: false, lease: null, reason: "missing-table" };
  }
  const now = process.now();
  const existing = readLease(db, name);
  if (existing !== null) {
    if (
      existing.holder_pid === process.pid &&
      existing.holder_boot_id === process.boot_id
    ) {
      heartbeatLease(db, process, name);
      return { acquired: true, lease: readLease(db, name), reason: "acquired" };
    }
    if (isBusy(existing, process, now)) {
      return { acquired: false, lease: existing, reason: "busy" };
    }
    reclaimDeadLease(db, name, process);
    const after = insertLease(db, name, process, now, ttl_s);
    return { acquired: true, lease: after, reason: "reclaimed" };
  }
  const lease = insertLease(db, name, process, now, ttl_s);
  return { acquired: true, lease, reason: "acquired" };
}

function insertLease(
  db: Database,
  name: string,
  process: LeaseProcess,
  now: string,
  ttl_s: number,
): LeaseRow {
  db.query(
    `INSERT INTO leases (name, holder_pid, holder_boot_id, acquired_at, heartbeat_at, ttl_s)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(name, process.pid, process.boot_id, now, now, ttl_s);
  const lease = readLease(db, name);
  if (lease === null) {
    throw new ServeDaemonError("lease_missing", "lease insert did not persist");
  }
  return lease;
}

export function heartbeatLease(
  db: Database,
  process: LeaseProcess,
  name = WRITER_LEASE,
): void {
  const existing = readLease(db, name);
  if (existing === null) {
    throw new ServeDaemonError("lease_missing", "cannot heartbeat a missing lease");
  }
  if (
    existing.holder_pid !== process.pid ||
    existing.holder_boot_id !== process.boot_id
  ) {
    throw new ServeDaemonError("lease_busy", "a live holder lease is never stolen");
  }
  db.query("UPDATE leases SET heartbeat_at = ? WHERE name = ?").run(
    process.now(),
    name,
  );
}

export function releaseLease(
  db: Database,
  process: LeaseProcess,
  name = WRITER_LEASE,
): void {
  const existing = readLease(db, name);
  if (existing === null) return;
  if (
    existing.holder_pid !== process.pid ||
    existing.holder_boot_id !== process.boot_id
  ) {
    throw new ServeDaemonError("lease_busy", "a live holder lease is never stolen");
  }
  db.query("DELETE FROM leases WHERE name = ?").run(name);
}

export function thisProcess(now: () => string = () => new Date().toISOString()): LeaseProcess {
  return {
    pid: process.pid,
    boot_id: readBootId(),
    now,
    isAlive: pidAlive,
  };
}
