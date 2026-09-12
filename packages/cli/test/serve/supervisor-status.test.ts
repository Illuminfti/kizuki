import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeServeIntent } from "@kizuki/core";
import { createHelpers } from "../helpers";
import { fakeSystemd } from "./supervisor-fixture";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

for (const [activity, enablement, expectedState, detail] of [
  ["failed", "enabled", "disabled", "failed"],
  ["inactive", "enabled", "disabled", "inactive (enabled)"],
  ["inactive", "disabled", "disabled", "disabled"],
  ["failed", "masked", "masked", "failed"],
] as const) {
  test(`public status and doctor distinguish systemd ${enablement}/${activity}`, () => {
    const setup = tempVault();
    writeServeIntent(setup.vault, "installed");
    const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd", TEST_SUPERVISOR_STATE: enablement,
      TEST_SUPERVISOR_ACTIVITY: activity, TEST_SUPERVISOR_ACTIVITY_EXIT: "3" };
    const expected = { kind: "systemd", state: expectedState, enabled: enablement === "enabled", detail };
    const status = runCli(env, "serve", "status", "--json");
    expect(status.exitCode).toBe(1);
    const body = JSON.parse(status.stdout).data;
    expect(body.supervisor).toMatchObject(expected);
    expect(body.doctor.supervisor).toEqual(body.supervisor);
    expect(body.doctor.ok).toBe(false);
    const doctor = runCli(env, "doctor", "--json");
    expect(doctor.exitCode).toBe(1);
    const report = JSON.parse(doctor.stdout).data;
    expect(report.serve.supervisor).toEqual(body.supervisor);
    expect(report.serve.ok).toBe(false);
    expect(runCli(env, "serve", "status").stdout).toContain("\n" + detail + "\n");
    expect(runCli(env, "doctor").stdout).toContain("\n" + detail + "\n");
  });
}

for (const [name, body, expected, detail] of [
  ["exited", "\tstate = exited\n\tlast exit code = 78\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "failed (last exit code 78)"],
  ["not running", "\tstate = not running\n\tlast exit code = 0\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "stopped (last exit code 0)"],
  ["waiting", "\tstate = waiting\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "loaded but not running"],
  ["running with disabled = 0", "\tstate = running\n\tpid = 98765\n\tdisabled = 0\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "active", enabled: true }, "active"],
  ["running with SERVICE_DISABLED", "\tstate = running\n\tpid = 98765\n\tenvironment = {\n\t\tSERVICE_DISABLED = 1\n\t\tPRIVATE_MANAGER_CANARY = hidden\n\t}\n", { state: "active", enabled: true }, "active"],
  ["anchored disabled", "\tstate = not running\n\tdisabled = 1\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "loaded but not running"],
  ["anchored unloaded", "\tstate = unloaded\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "loaded but not running"],
  ["running without pid", "\tstate = running\n\tenvironment = { PRIVATE_MANAGER_CANARY = hidden }\n", { state: "disabled", enabled: true }, "loaded but not running"],
] as const) {
  test(`public status and doctor distinguish loaded launchd ${name}`, () => {
    const setup = tempVault(), bin = join(setup.root, "synthetic-launchd"), trace = join(setup.root, "queries.jsonl");
    mkdirSync(bin, { mode: 0o700 });
    writeServeIntent(setup.vault, "installed");
    const id = readFileSync(join(setup.vault, ".kizuki/vault-id"), "utf8").trim();
    const output = "gui/501/dev.kizuki.synthetic = {\n" + body + "}";
    writeFileSync(join(bin, "launchctl"), `#!${process.execPath}
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
assert.deepEqual(args,['print','gui/'+process.getuid()+'/'+${JSON.stringify("dev.kizuki." + id)}]);
appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
process.stdout.write(${JSON.stringify(output)});
process.stderr.write('disabled PRIVATE_MANAGER_CANARY');
`, { mode: 0o700 });
    const env = { ...setup.env, KIZUKI_SUPERVISOR: "launchd", PATH: bin + ":" + process.env.PATH };
    const status = runCli(env, "serve", "status", "--json");
    expect(status.exitCode).toBe(1);
    const report = JSON.parse(status.stdout).data;
    expect(report.supervisor).toMatchObject({ kind: "launchd", ...expected, detail });
    expect(report.doctor.supervisor).toEqual(report.supervisor);
    expect(report.doctor.ok).toBe(false);
    const doctor = runCli(env, "doctor", "--json");
    expect(doctor.exitCode).toBe(1);
    const doctorReport = JSON.parse(doctor.stdout).data;
    expect(doctorReport.serve.supervisor).toEqual(report.supervisor);
    expect(doctorReport.serve.ok).toBe(false);
    expect(status.stdout + status.stderr + doctor.stdout + doctor.stderr).not.toContain("PRIVATE_MANAGER_CANARY");
    expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(3);
  });
}
