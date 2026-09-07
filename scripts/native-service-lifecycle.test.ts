import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStoppedNativeFixture, managerPid, nativeServiceStopped, nativeWaitTimeout, waitForNativeState } from "./native-service-lifecycle";
import { HEARTBEAT_SECONDS, LEASE_RECLAIM_HEARTBEATS } from "../packages/core/src/serve/types";

test("only the two supervisor restart gates allow lease expiry plus bounded startup time", () => {
  const restart = (HEARTBEAT_SECONDS * LEASE_RECLAIM_HEARTBEATS + 15) * 1000;
  for (const id of ["crash-restarts-new-instance", "launchd-restarts-after-graceful-exit"]) expect(nativeWaitTimeout(id)).toBe(restart);
  for (const id of ["default-init-running", "repeat-install-replaces-process", "graceful process stop", "uninstall stops service", "final uninstall stop", "unknown step"])
    expect(nativeWaitTimeout(id)).toBe(30_000);
});

test("the actual restart wait accepts a new instance after 31 seconds while an install still times out", () => {
  // Isolate the deterministic clock from other tests; no host service is used.
  const script = `
    import { strict as assert } from 'node:assert';
    const { waitForNativeState } = await import(${JSON.stringify(join(import.meta.dir, "native-service-lifecycle.ts"))});
    let clock = 0, diagnostics = 0;
    Date.now = () => clock;
    Bun.sleep = async (ms) => { clock += ms; };
    for (const description of ['crash-restarts-new-instance', 'launchd-restarts-after-graceful-exit']) {
      clock = 0;
      await waitForNativeState(() => clock >= 31000, description, () => { diagnostics++; });
      assert.equal(clock, 31000);
    }
    assert.equal(diagnostics, 0);
    clock = 0;
    await assert.rejects(waitForNativeState(() => clock >= 31000, 'default-init-running', () => { diagnostics++; }), /timed out: default-init-running/);
    assert.equal(clock, 30000); assert.equal(diagnostics, 1);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});

test("native wait records timeout evidence before the caller cleans up", async () => {
  const events: string[] = [];
  try {
    await waitForNativeState(() => false, "synthetic restart", () => { events.push("diagnostics"); }, 0);
  } catch (error) {
    expect((error as Error).message).toBe("timed out: synthetic restart");
    events.push("failure");
  } finally { events.push("cleanup"); }
  expect(events).toEqual(["diagnostics", "failure", "cleanup"]);
});

test("failed timeout diagnostics preserve the original gate failure", async () => {
  await expect(waitForNativeState(() => false, "synthetic restart", () => {
    throw new Error("synthetic diagnostic failure");
  }, 0)).rejects.toThrow("timed out: synthetic restart");
});

test("a successful native wait does not collect failure diagnostics", async () => {
  let collected = false;
  await waitForNativeState(() => true, "synthetic restart", () => { collected = true; });
  expect(collected).toBe(false);
});

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


for (const [label, state, stopped] of [
  ["missing definition with active process", { exit_code: 0, stdout: "LoadState=not-found\nActiveState=active\nMainPID=802\n", stderr: "" }, false],
  ["query failure with inactive-looking output", { exit_code: 1, stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\n", stderr: "bus unavailable" }, false],
  ["missing definition without PID evidence", { exit_code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }, false],
  ["query failure without fields", { exit_code: 1, stdout: "", stderr: "bus unavailable" }, false],
  ["missing definition and confirmed inactive PID zero", { exit_code: 0, stdout: "LoadState=not-found\nActiveState=inactive\nMainPID=0\n", stderr: "" }, true],
] as const) {
  test(`actual native cleanup retains the fixture until stop is proved: ${label}`, () => {
    const report = mkdtempSync(join(tmpdir(), "kizuki-cleanup-refusal-"));
    const fixture = join(report, "synthetic-root"), unit = join(report, "owned.service");
    mkdirSync(fixture); writeFileSync(join(fixture, "evidence"), "synthetic"); writeFileSync(unit, "synthetic");
    try {
      expect(nativeServiceStopped("linux", state)).toBe(stopped);
      const cleanup = cleanupStoppedNativeFixture("linux", state, fixture, unit);
      const receipt = { passed: cleanup.service_gone && cleanup.unit_removed, cleanup };
      writeFileSync(join(report, "receipt.json"), JSON.stringify(receipt));
      expect(JSON.parse(readFileSync(join(report, "receipt.json"), "utf8")).passed).toBe(stopped);
      expect(existsSync(fixture)).toBe(!stopped);
      expect(existsSync(unit)).toBe(!stopped);
      if (!stopped) expect(readFileSync(join(fixture, "evidence"), "utf8")).toBe("synthetic");
    } finally { rmSync(report, { recursive: true }); }
  });
}
