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
  test("unknown boot identity cannot justify stealing a live holder", () => {
    for (const [before, after] of [["pid:11", "pid:22"], ["boot-a", "pid:22"], ["pid:11", "boot-b"], ["", "boot-b"]]) {
      const db = openDb();
      try {
        acquireLease(db, processAt(11, before!, [11]));
        const contender = processAt(22, after!, [11, 22], "2026-09-03T01:00:00Z");
        expect(acquireLease(db, contender).reason).toBe("busy");
        expect(() => reclaimDeadLease(db, "writer", contender)).toThrow(ServeDaemonError);
        expect(readLease(db, "writer")?.holder_pid).toBe(11);
      } finally { db.close(); }
    }
  });

  test("failed replacement preserves the prior boot lease for retry", () => {
    const db = openDb();
    try {
      acquireLease(db, processAt(11, "boot-a", [11]));
      const original = readLease(db, "writer");
      db.exec("CREATE TRIGGER refuse_lease BEFORE INSERT ON leases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
      const contender = processAt(22, "boot-b", [11, 22]);
      expect(() => acquireLease(db, contender)).toThrow("synthetic failure");
      expect(readLease(db, "writer")).toEqual(original);
      db.exec("DROP TRIGGER refuse_lease");
      expect(acquireLease(db, contender).reason).toBe("reclaimed");
      expect(readLease(db, "writer")?.holder_pid).toBe(22);
    } finally { db.close(); }
  });

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
