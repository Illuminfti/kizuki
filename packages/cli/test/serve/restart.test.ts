import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRunReceipt, readBootId, recoverRunJournal } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("kizuki serve restart", () => {
  test("a kill after the file write converges on restart", () => {
    const setup = tempVault();
    const crashed = runCli(
      setup.env,
      "serve",
      "run",
      "brief",
      "--crash-after",
      "after-file",
      "--json",
    );
    expect(crashed.exitCode).toBe(1);
    expect(existsSync(join(setup.vault, "dashboards"))).toBe(true);
    const recovered = runCli(setup.env, "serve", "run", "brief", "--json");
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toContain('"rail":"brief"');
  });

  test("a kill after the JSONL append converges on restart", () => {
    const setup = tempVault();
    const crashed = runCli(
      setup.env,
      "serve",
      "run",
      "doctor-sweep",
      "--crash-after",
      "after-jsonl",
    );
    expect(crashed.exitCode).toBe(1);
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const recovered = recoverRunJournal(db, setup.vault);
      expect(recovered).toHaveLength(1);
      expect(getRunReceipt(db, recovered[0] ?? "")?.rail).toBe("doctor-sweep");
    } finally {
      db.close();
    }
    const again = runCli(setup.env, "serve", "--once", "--no-http", "--json");
    expect(again.exitCode).toBe(0);
  });

  test("a kill after the database row converges on restart", () => {
    const setup = tempVault();
    const crashed = runCli(
      setup.env,
      "serve",
      "run",
      "journal-prune",
      "--crash-after",
      "after-db",
    );
    expect(crashed.exitCode).toBe(1);
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      expect(
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()?.n,
      ).toBe(1);
      expect(recoverRunJournal(db, setup.vault)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a live lease is never stolen by a second process", () => {
    // The recorded boot_id must match this process's own, or the fixture
    // is indistinguishable from a lease left by a previous boot (#441) and
    // proves nothing about same-boot liveness.
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      db.query(
        `INSERT INTO leases (name, holder_pid, holder_boot_id, acquired_at, heartbeat_at, ttl_s)
         VALUES ('writer', ?, ?, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 30)`,
      ).run(process.pid, readBootId());
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "serve", "--once", "--no-http");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("live process");
  });

  // A PID fallback cannot prove a reboot; the core suite tests that it refuses
  // to steal a live holder. This consumer case requires a native boot identity.
  test.skipIf(readBootId().startsWith("pid:"))("a container starts cleanly after a host reboot left the writer lease behind (#441)", () => {
    // Simulates a host reboot without rebooting hardware: a lease row is left
    // by "the previous boot" holding this test process's own PID — which is
    // trivially alive, exactly like a container's PID 1 recurring across a
    // reboot — but stamped with a boot_id distinct from the one this process
    // actually reports. A daemon that only checks PID liveness would refuse
    // forever; one that reads boot_id reclaims the orphaned lease and starts.
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      db.query(
        `INSERT INTO leases (name, holder_pid, holder_boot_id, acquired_at, heartbeat_at, ttl_s)
         VALUES ('writer', ?, 'boot-before-reboot', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 30)`,
      ).run(process.pid);
    } finally {
      db.close();
    }
    const result = runCli(setup.env, "serve", "--once", "--no-http", "--json");
    expect(result.exitCode).toBe(0);
    // The run completed and released its own lease cleanly; the orphaned
    // row from "the previous boot" is gone, not merely overwritten.
    const afterDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const row = afterDb
        .query<{ holder_boot_id: string }, []>(
          "SELECT holder_boot_id FROM leases WHERE name = 'writer'",
        )
        .get();
      expect(row).toBeNull();
    } finally {
      afterDb.close();
    }
  });
});
