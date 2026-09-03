import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import {
  acquireLease,
  heartbeatLease,
  readLease,
  reclaimDeadLease,
  releaseLease,
  type LeaseProcess,
} from "../../src/serve/leases";
import { ServeDaemonError } from "../../src/serve/types";

const dirs: string[] = [];

function processAt(
  pid: number,
  boot: string,
  alive: readonly number[],
  now = "2026-09-03T00:00:00Z",
): LeaseProcess {
  return {
    pid,
    boot_id: boot,
    now: () => now,
    isAlive: (candidate) => alive.includes(candidate),
  };
}

function openDb() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-lease-"));
  dirs.push(directory);
  return openLedger(join(directory, "ledger.sqlite"));
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("leases", () => {
  test("a live holder's lease is never stolen", () => {
    const db = openDb();
    const first = processAt(11, "boot-a", [11]);
    expect(acquireLease(db, first).acquired).toBe(true);
    const second = processAt(22, "boot-a", [11, 22]);
    const result = acquireLease(db, second);
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("busy");
    expect(() => reclaimDeadLease(db, "writer", second)).toThrow(ServeDaemonError);
    expect(readLease(db, "writer")?.holder_pid).toBe(11);
    db.close();
  });

  test("a dead holder's lease is reclaimed with a receipt", () => {
    const db = openDb();
    const first = processAt(11, "boot-a", [11], "2026-09-03T00:00:00Z");
    expect(acquireLease(db, first).acquired).toBe(true);
    const successor = processAt(22, "boot-b", [22], "2026-09-03T00:01:00Z");
    const result = acquireLease(db, successor);
    expect(result.acquired).toBe(true);
    expect(result.reason).toBe("reclaimed");
    expect(readLease(db, "writer")?.holder_pid).toBe(22);
    db.close();
  });

  test("the holder can heartbeat and release", () => {
    const db = openDb();
    const holder = processAt(11, "boot-a", [11], "2026-09-03T00:00:00Z");
    acquireLease(db, holder);
    const later: LeaseProcess = {
      ...holder,
      now: () => "2026-09-03T00:00:10Z",
    };
    heartbeatLease(db, later);
    expect(readLease(db, "writer")?.heartbeat_at).toBe("2026-09-03T00:00:10Z");
    releaseLease(db, later);
    expect(readLease(db, "writer")).toBeNull();
    db.close();
  });
});
