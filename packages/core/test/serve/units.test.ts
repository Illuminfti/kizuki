import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVE_CONFIG } from "../../src/serve/types";
import {
  launchdLabel,
  renderLaunchdPlist,
  renderSystemdUnit,
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
});
