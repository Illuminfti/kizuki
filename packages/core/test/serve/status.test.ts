import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { serveStatus } from "../../src/serve/daemon";
import { acquireLease, readLease, type LeaseProcess } from "../../src/serve/leases";

const dirs: string[] = [];

function processAt(
  pid: number,
  boot: string,
  alive: readonly number[],
  now = "2026-09-03T00:00:00Z",
): LeaseProcess {
  return { pid, boot_id: boot, now: () => now, isAlive: (candidate) => alive.includes(candidate) };
}

function openVault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-serve-status-"));
  dirs.push(directory);
  return { directory, db: openLedger(join(directory, "ledger.sqlite")) };
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("serveStatus", () => {
  test("reports a lease this live process holds as held", () => {
    const { directory, db } = openVault();
    try {
      const owner = processAt(11, "boot-a", [11]);
      expect(acquireLease(db, owner).acquired).toBe(true);
      expect(serveStatus(db, directory, owner).lease).toBe("held");
    } finally { db.close(); }
  });

  test("a status read never releases or reclaims the lease it reports", () => {
    const { directory, db } = openVault();
    try {
      const owner = processAt(11, "boot-a", [11]);
      acquireLease(db, owner);
      serveStatus(db, directory, owner);
      expect(readLease(db, "writer")?.holder_pid).toBe(11);

      const dead = processAt(12, "boot-a", [12], "2026-09-03T02:00:00Z");
      expect(serveStatus(db, directory, dead).lease).toBe("free");
      expect(readLease(db, "writer")?.holder_pid).toBe(11);
    } finally { db.close(); }
  });

  test("reports another live holder as busy and an empty table as free", () => {
    const { directory, db } = openVault();
    try {
      acquireLease(db, processAt(11, "boot-a", [11]));
      expect(serveStatus(db, directory, processAt(12, "boot-a", [11, 12])).lease).toBe("busy");
    } finally { db.close(); }

    const fresh = openVault();
    try {
      expect(serveStatus(fresh.db, fresh.directory, processAt(11, "boot-a", [11])).lease).toBe("free");
    } finally { fresh.db.close(); }
  });
});
