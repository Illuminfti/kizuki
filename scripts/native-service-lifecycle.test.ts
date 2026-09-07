import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managerPid } from "./native-service-lifecycle";

for (const [platform, stdout, exit, expected] of [
  ["darwin", "\tstate = running\n\tpid = 501\n", 0, 501],
  ["darwin", "\tstate = waiting\n\tpid = 501\n", 0, null],
  ["darwin", "state = running\npid = 501\n", 3, null],
  ["darwin", "note state = running\nnote pid = 501\n", 0, null],
  ["darwin", "state = running\npid = 1\n", 0, null],
  ["darwin", "state = running\npid = 999999999999999999\n", 0, null],
  ["linux", "MainPID=802\nActiveState=active\n", 0, 802],
  ["linux", "MainPID=802\nActiveState=activating\n", 0, null],
  ["linux", "MainPID=0\nActiveState=failed\n", 0, null],
  ["linux", "MainPID=802\nActiveState=active\n", 1, null],
  ["linux", "OtherMainPID=802\nActiveState=active\n", 0, null],
  ["win32", "MainPID=802\nActiveState=active\n", 0, null],
] as const) {
  test(`native manager PID requires activity, exact fields and success: ${platform}/${stdout}/${exit}`, () => {
    expect(managerPid(platform, { stdout, exit_code: exit, stderr: "pid = 501" })).toBe(expected);
  });
}

test("native service harness refuses local service mutation and retains the failed prerequisite", () => {
  const report = mkdtempSync(join(tmpdir(), "kizuki-lifecycle-prerequisite-"));
  try {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "native-service-lifecycle.ts"), "--artifact", join(report, "absent"), "--report", report], {
      env: { PATH: "/usr/bin:/bin", HOME: report }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    const receipt = JSON.parse(readFileSync(join(report, "receipt.json"), "utf8"));
    expect(receipt.passed).toBe(false);
    expect(receipt.failures).toEqual(["native service proof requires an ephemeral GitHub Actions runner"]);
    expect(receipt.steps).toEqual([]);
    expect(receipt.cleanup.service_gone).toBe(true);
    expect(receipt.binary_sha256).toBe("unavailable");
    expect(receipt.scope.release_upgrade).toBe(false);
    expect(receipt.scope.migration_rollback).toBe(false);
  } finally { rmSync(report, { recursive: true }); }
});
