import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVE_CONFIG, HEARTBEAT_SECONDS, LEASE_RECLAIM_HEARTBEATS } from "../../src/serve/types";
import { acquireLease } from "../../src/serve/leases";
import { openLedger } from "../../src/ledger/db";
import {
  launchdLabel,
  renderLaunchdPlist,
  renderSystemdUnit,
  SERVICE_BROKER_REAP_SECONDS,
  SERVICE_READY_SECONDS,
  SERVICE_START_SECONDS,
  SERVICE_STOP_SECONDS,
  systemdUnitName,
} from "../../src/serve/units";

const spec = {
  vaultPath: "/tmp/vault-ada",
  vaultId: "01jbvault0000000000000001",
  execStart: "/usr/bin/bun /opt/kizuki/packages/cli/src/main.ts serve --vault /tmp/vault-ada",
  config: DEFAULT_SERVE_CONFIG,
};

describe("serve units", () => {
  test("systemd unit hardens the process and never lists a secret", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=read-only");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("ExitType=main");
    expect(unit).toContain("KillMode=control-group");
    expect(SERVICE_READY_SECONDS).toBe(15);
    expect(SERVICE_BROKER_REAP_SECONDS).toBe(2);
    expect(SERVICE_START_SECONDS).toBe(SERVICE_READY_SECONDS + SERVICE_BROKER_REAP_SECONDS + 1);
    expect(SERVICE_STOP_SECONDS).toBe(90);
    expect(unit).toContain(`TimeoutStartSec=${SERVICE_START_SECONDS}s`);
    expect(unit).toContain(`TimeoutStopSec=${SERVICE_STOP_SECONDS}s`);
    expect(unit).toContain(`ExecStart=${spec.execStart} --service-custody ${spec.vaultId}`);
    expect(unit).toContain(`ExecStartPost=+${spec.execStart} --custody-broker-launch ${spec.vaultId}`);
    expect(unit).not.toContain("ExecStart=+");
    expect(unit).toContain("ReadWritePaths=/tmp/vault-ada");
    expect(unit).toContain("MemoryMax=2G");
    expect(unit).toContain("CPUQuota=60%");
    expect(unit).toContain("Nice=10");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("deliberately not applied");
    expect(unit).not.toMatch(/Environment=.*KEY/);
    expect(unit).not.toContain("secret");
    expect(systemdUnitName(spec.vaultId)).toBe("kizuki@01jbvault0000000000000001.service");
  });

  test("launchd plist runs at load and keeps alive", () => {
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(launchdLabel(spec.vaultId));
    expect(plist).not.toContain("secret");
  });

  test("both supervisor restart delays outlast a freshly orphaned writer lease", () => {
    const systemd = renderSystemdUnit(spec), launchd = renderLaunchdPlist(spec);
    const delays = [Number(/^RestartSec=(\d+)s$/m.exec(systemd)?.[1]),
      Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(launchd)?.[1])];
    const window = HEARTBEAT_SECONDS * LEASE_RECLAIM_HEARTBEATS;
    for (const seconds of delays) {
      expect(seconds).toBe(window + 1);
      const db = openLedger(":memory:");
      try {
        const start = Date.parse("2026-09-07T00:00:00.000Z");
        const now = (offset: number) => () => new Date(start + offset * 1000).toISOString();
        expect(acquireLease(db, { pid: 100, boot_id: "synthetic-boot", now: now(0), isAlive: () => false }).acquired).toBe(true);
        // The lease contract still refuses a dead but fresh holder. The
        // rendered supervisor delay, rather than weaker freshness, permits restart.
        expect(acquireLease(db, { pid: 101, boot_id: "synthetic-boot", now: now(window - 1), isAlive: () => false }).reason).toBe("busy");
        expect(acquireLease(db, { pid: 101, boot_id: "synthetic-boot", now: now(seconds), isAlive: () => false }).reason).toBe("reclaimed");
      } finally { db.close(); }
    }
  });
});
