import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";
import { fakeSystemd } from "./supervisor-fixture";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("public install confirms launchd running pid despite disabled substrings", () => {
  const setup = tempVault(), bin = join(setup.root, "synthetic-launchd"), state = join(setup.root, "launchd-state.json");
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(state, JSON.stringify({ loaded: false }), { mode: 0o600 });
  writeFileSync(join(bin, "launchctl"), `#!${process.execPath}
import {readFileSync, writeFileSync} from 'node:fs';
const path = ${JSON.stringify(state)};
const s = JSON.parse(readFileSync(path, 'utf8')), args = process.argv.slice(2);
let code = 0, stdout = '', stderr = '';
if (args[0] === 'print') {
  if (!s.loaded) { code = 113; stderr = 'Could not find service in domain for user gui'; }
  else stdout = 'state = running\\npid = 98765\\ndisabled = 0\\nenvironment = { SERVICE_DISABLED = 1 }';
} else if (args[0] === 'bootstrap') { s.loaded = true; }
else if (args[0] === 'bootout') { s.loaded = false; }
else code = 1;
writeFileSync(path, JSON.stringify(s));
process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code);
`, { mode: 0o700 });
  const env = { ...setup.env, KIZUKI_SUPERVISOR: "launchd", PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  expect(JSON.parse(installed.stdout).data.status).toMatchObject({ kind: "launchd", state: "active", enabled: true });
  const id = readFileSync(join(setup.vault, ".kizuki", "vault-id"), "utf8").trim();
  expect(existsSync(join(setup.env.HOME!, "Library", "LaunchAgents", `dev.kizuki.${id}.plist`))).toBe(true);
});

test("public install and uninstall refuse failed supervisor transitions", () => {
  const setup = tempVault();
  const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  const failed = runCli({ ...env, TEST_SUPERVISOR_FAIL: "start" }, "serve", "--install", "--json");
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

for (const [enablement, activity, exit, expected] of [
    ["masked", "active", "0", "active"],
    ["disabled", "unknown", "4", "unknown"],
    ["masked", "unknown", "4", "unknown"],
    ["disabled", "deactivating", "3", "unknown"],
    ["enabled", "activating", "3", "unknown"],
  ] as const) {
  test(`${enablement} enablement with ${activity} activity cannot prove a service stopped`, () => {
    const setup = tempVault();
    const env = {...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd"};
    const installed = runCli(env, "serve", "--install", "--json");
    expect(installed.exitCode).toBe(0);
    const unit = JSON.parse(installed.stdout).data.unitPath;
    const original = readFileSync(unit, "utf8");
    const uncertain = {...env, TEST_SUPERVISOR_STATE: enablement, TEST_SUPERVISOR_ACTIVITY: activity, TEST_SUPERVISOR_ACTIVITY_EXIT: exit};
    expect(runCli(uncertain, "serve", "--uninstall", "--json").exitCode).toBe(1);
    expect(readFileSync(unit, "utf8")).toBe(original);
    expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
    const status = runCli(uncertain, "serve", "status", "--json");
    expect(status.exitCode).toBe(1);
    expect(JSON.parse(status.stdout).data.supervisor.state).toBe(expected);
    expect(JSON.parse(status.stdout).data.doctor.ok).toBe(false);
  });
}

test("uninstall refreshes the manager cache and failed refresh retains recoverable installed state", () => {
  const setup = tempVault();
  const xdg = join(setup.root, "cached-config"), cache = join(setup.root, "cached-definition");
  const env = {...fakeSystemd(setup.root, setup.env), XDG_CONFIG_HOME: xdg, KIZUKI_SUPERVISOR: "systemd",
    TEST_SUPERVISOR_CACHE: cache, TEST_SUPERVISOR_UNITS: join(xdg, "systemd", "user")};
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  const unit = JSON.parse(installed.stdout).data.unitPath;
  const original = readFileSync(unit, "utf8");
  expect(readFileSync(cache, "utf8")).toBe(original);
  const failed = runCli({...env, TEST_SUPERVISOR_FAIL: "daemon-reload"}, "serve", "--uninstall", "--json");
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain("recovery is pending");
  expect(readFileSync(unit, "utf8")).toBe(original);
  expect(readFileSync(cache, "utf8")).toBe(original);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(true);
  const removed = runCli(env, "serve", "--uninstall", "--json");
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout).data.status.state).toBe("absent");
  expect(existsSync(unit)).toBe(false);
  expect(readFileSync(cache, "utf8")).toBe("");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
});

function ordinaryVault(vault: string): Record<string, string> {
  const skip = new Set(["serve-intent", "service-change.json", "service-change.lock"]);
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === ".kizuki" && skip.has(name)) continue;
      const path = join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, next);
      else files[next] = readFileSync(path).toString("hex");
    }
  };
  walk(vault, "");
  return files;
}

function assertSyntheticSystemctl(root: string, env: Record<string, string | undefined>, bin = join(root, "synthetic-bin")): void {
  expect(env.PATH?.split(":")[0]).toBe(bin);
  const resolved = Bun.spawnSync(["sh", "-c", "command -v systemctl"], { env: { PATH: env.PATH ?? "" } });
  expect(resolved.stdout.toString().trim()).toBe(join(bin, "systemctl"));
}

function withCommandLog(root: string, env: Record<string, string | undefined>): { env: Record<string, string | undefined>; log: string } {
  const bin = join(root, "logged-bin");
  mkdirSync(bin, { mode: 0o700 });
  const log = join(root, "systemctl.log");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exec ${JSON.stringify(join(root, "synthetic-bin", "systemctl"))} "$@"
`, { mode: 0o700 });
  return { env: { ...env, PATH: `${bin}:${env.PATH ?? ""}` }, log };
}

function commandLines(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

test("public uninstall of an enabled inactive unit preserves vault bytes and does not activate", () => {
  const setup = tempVault();
  const base = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  assertSyntheticSystemctl(setup.root, base);
  const logged = withCommandLog(setup.root, base);
  assertSyntheticSystemctl(setup.root, logged.env, join(setup.root, "logged-bin"));
  expect(runCli(logged.env, "serve", "--install").exitCode).toBe(0);
  const id = readFileSync(join(setup.vault, ".kizuki", "vault-id"), "utf8").trim();
  const unit = join(setup.env.XDG_CONFIG_HOME!, "systemd", "user", `kizuki@${id}.service`);
  const original = readFileSync(unit, "utf8");
  const before = ordinaryVault(setup.vault);
  writeFileSync(logged.env.TEST_SUPERVISOR_FILE!, "enabled\n");
  writeFileSync(join(setup.root, "systemctl.log"), "");
  const removed = runCli(logged.env, "serve", "--uninstall", "--json");
  expect(removed.exitCode).toBe(0);
  expect(removed.stdout).toContain('"status":"ok"');
  const status = JSON.parse(removed.stdout).data.status;
  expect(status.enabled).toBe(false);
  expect(["disabled", "absent", "masked"]).toContain(status.state);
  expect(existsSync(unit)).toBe(false);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("opted-out");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
  expect(ordinaryVault(setup.vault)).toEqual(before);
  const commands = commandLines(logged.log);
  expect(commands.some(line => line.includes("disable"))).toBe(true);
  expect(commands.some(line => line.includes("daemon-reload"))).toBe(true);
  expect(commands.some(line => line.includes("restart"))).toBe(false);
  expect(commands.some(line => /(^|\s)enable(\s|$)/.test(line))).toBe(false);
  expect(original).toContain("ExecStart=");
  expect(original).toContain("TimeoutStartSec=");
  expect(original).toContain("TimeoutStopSec=90s");
});

test("public reinstall of an enabled inactive unit still activates the current definition", () => {
  const setup = tempVault();
  const env: Record<string, string | undefined> = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  assertSyntheticSystemctl(setup.root, env);
  expect(runCli(env, "serve", "--install").exitCode).toBe(0);
  writeFileSync(env.TEST_SUPERVISOR_FILE!, "enabled\n");
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  expect(installed.stdout).toContain('"status":"ok"');
  const status = JSON.parse(installed.stdout).data.status;
  expect(status.state).toBe("active");
  expect(status.enabled).toBe(true);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
});

test("failed reinstall from enabled inactive restores original inactivity without a success payload", () => {
  const setup = tempVault();
  const env: Record<string, string | undefined> = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  assertSyntheticSystemctl(setup.root, env);
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  const unit = JSON.parse(installed.stdout).data.unitPath;
  const original = readFileSync(unit, "utf8");
  const before = ordinaryVault(setup.vault);
  writeFileSync(env.TEST_SUPERVISOR_FILE!, "enabled\n");
  const failed = runCli({ ...env, TEST_SUPERVISOR_FAIL: "start" }, "serve", "--install", "--json");
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).not.toContain('"status":"ok"');
  expect(failed.stderr).toContain("previous configuration restored");
  expect(readFileSync(unit, "utf8")).toBe(original);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
  expect(ordinaryVault(setup.vault)).toEqual(before);
  const status = runCli(env, "serve", "status", "--json");
  expect(JSON.parse(status.stdout).data.supervisor.state).toBe("disabled");
  expect(JSON.parse(status.stdout).data.supervisor.enabled).toBe(true);
});

test("public install waits for start past the default command timeout without rollback", () => {
  const setup = tempVault();
  const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd", TEST_SUPERVISOR_SLEEP: "start" };
  assertSyntheticSystemctl(setup.root, env);
  const started = Date.now();
  const installed = runCli(env, "serve", "--install", "--json");
  expect(Date.now() - started).toBeGreaterThan(5_000);
  expect(installed.exitCode).toBe(0);
  expect(installed.stdout).toContain('"status":"ok"');
  const status = JSON.parse(installed.stdout).data.status;
  expect(status.state).toBe("active");
  expect(status.enabled).toBe(true);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
}, 20_000);

test("public uninstall waits for disable past the default command timeout without rollback", () => {
  const setup = tempVault();
  const env = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  assertSyntheticSystemctl(setup.root, env);
  expect(runCli(env, "serve", "--install").exitCode).toBe(0);
  const started = Date.now();
  const removed = runCli({ ...env, TEST_SUPERVISOR_SLEEP: "disable" }, "serve", "--uninstall", "--json");
  expect(Date.now() - started).toBeGreaterThan(5_000);
  expect(removed.exitCode).toBe(0);
  expect(removed.stdout).toContain('"status":"ok"');
  const status = JSON.parse(removed.stdout).data.status;
  expect(status.enabled).toBe(false);
  expect(["disabled", "absent", "masked"]).toContain(status.state);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("opted-out");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
}, 20_000);

test("ordinary failed recovery from enabled inactive returns nonzero and later converges", () => {
  const setup = tempVault();
  const env: Record<string, string | undefined> = { ...fakeSystemd(setup.root, setup.env), KIZUKI_SUPERVISOR: "systemd" };
  assertSyntheticSystemctl(setup.root, env);
  const installed = runCli(env, "serve", "--install", "--json");
  expect(installed.exitCode).toBe(0);
  const unit = JSON.parse(installed.stdout).data.unitPath;
  const original = readFileSync(unit, "utf8");
  writeFileSync(env.TEST_SUPERVISOR_FILE!, "enabled\n");
  const failed = runCli({ ...env, TEST_SUPERVISOR_FAIL: "disable" }, "serve", "--uninstall", "--json");
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).not.toContain('"status":"ok"');
  expect(failed.stderr).toContain("recovery is pending");
  expect(readFileSync(unit, "utf8")).toBe(original);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("installed");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(true);
  const removed = runCli(env, "serve", "--uninstall", "--json");
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(removed.stdout).data.status.enabled).toBe(false);
  expect(existsSync(unit)).toBe(false);
  expect(readFileSync(join(setup.vault, ".kizuki", "serve-intent"), "utf8").trim()).toBe("opted-out");
  expect(existsSync(join(setup.vault, ".kizuki", "service-change.json"))).toBe(false);
});
