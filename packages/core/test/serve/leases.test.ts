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

  test("a holder reusing a PID number after a host reboot is reclaimed, not busy (#441)", () => {
    // Inside a container the entrypoint is always PID 1. After a host
    // reboot, the new PID-1 process's isAlive check trivially matches a
    // lease left by the previous boot's PID 1 unless boot_id is consulted.
    const db = openDb();
    const beforeReboot = processAt(1, "boot-before", [1], "2026-09-03T00:00:00Z");
    expect(acquireLease(db, beforeReboot).acquired).toBe(true);
    // Same PID number, alive under the new boot too, but a different boot_id:
    // the holder that recorded this lease died with its machine.
    const afterReboot = processAt(1, "boot-after", [1], "2026-09-03T00:01:00Z");
    const result = acquireLease(db, afterReboot);
    expect(result.acquired).toBe(true);
    expect(result.reason).toBe("reclaimed");
    expect(readLease(db, "writer")?.holder_boot_id).toBe("boot-after");
    db.close();
  });

  test("a live holder on the same boot is never stolen even after a stale heartbeat", () => {
    const db = openDb();
    const holder = processAt(11, "boot-a", [11], "2026-09-03T00:00:00Z");
    expect(acquireLease(db, holder).acquired).toBe(true);
    // Same boot, same PID still alive, well past the staleness window: must
    // still be busy, because a genuinely live holder is never stolen.
    const challenger = processAt(22, "boot-a", [11, 22], "2026-09-03T01:00:00Z");
    const result = acquireLease(db, challenger);
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("busy");
    expect(() => reclaimDeadLease(db, "writer", challenger)).toThrow(ServeDaemonError);
    expect(readLease(db, "writer")?.holder_pid).toBe(11);
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
