import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";
import { fakeSystemd } from "./supervisor-fixture";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("public install and uninstall refuse failed supervisor transitions", () => {
  const setup = tempVault();
  const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  const failed = runCli({ ...env, TEST_SUPERVISOR_FAIL: "restart" }, "serve", "--install", "--json");
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).not.toContain('"status":"ok"');
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("opted-out");
  expect(runCli(env, "serve", "--install").exitCode).toBe(0);
  const stop = runCli({ ...env, TEST_SUPERVISOR_FAIL: "disable" }, "serve", "--uninstall");
  expect(stop.exitCode).toBe(1);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
  expect(runCli(env, "serve", "--uninstall").exitCode).toBe(0);
});

test("a production environment flag cannot invent an active supervisor", () => {
  const setup = tempVault();
  const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  expect(runCli(env, "serve", "--install").exitCode).toBe(0);
  const result = runCli({ ...env, TEST_SUPERVISOR_STATE: "absent", KIZUKI_SUPERVISOR_FIXTURE: "active" }, "serve", "status", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('"state":"absent"');
});

test("public service installation uses XDG config directly even with empty HOME", () => {
  const setup = tempVault();
  const xdg = join(setup.root, "service-config");
  const env = { ...fakeSystemd(setup.root, setup.env), HOME: "", XDG_CONFIG_HOME: xdg, KIZUKI_SUPERVISOR: "systemd" };
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  const id = readFileSync(join(setup.vault, ".kizuki", "vault-id"), "utf8").trim();
  const unit = join(xdg, "systemd", "user", `kizuki@${id}.service`);
  expect(existsSync(unit)).toBe(true);
  expect(existsSync(join(xdg, ".config"))).toBe(false);
  const status = runCli(env, "serve", "status", "--json");
  // The synthetic supervisor runs no rails: installation is visible, health remains red.
  expect(status.exitCode).toBe(1);
  const report = JSON.parse(status.stdout).data;
  expect(report.supervisor.state).toBe("active");
  expect(report.doctor.intent).toBe("installed");
  expect(report.doctor.failures.every((failure: string) => /^rail .+: no receipt$/.test(failure))).toBe(true);
  expect(runCli(env, "serve", "--uninstall").exitCode).toBe(0);
  expect(existsSync(unit)).toBe(false);
});
