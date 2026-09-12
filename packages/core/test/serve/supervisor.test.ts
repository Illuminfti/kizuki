import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import {
  installServeService, realSupervisorHost, SUPERVISOR_COMMAND_TIMEOUT_MS,
  SYSTEMD_RESTART_TIMEOUT_MS, SYSTEMD_START_TIMEOUT_MS, SYSTEMD_STOP_TIMEOUT_MS,
  systemdCommandTimeoutMs, uninstallServeService,
  type SupervisorCommandResult, type SupervisorHost, type SupervisorTimeoutAdapter,
} from "../../src/serve/supervisor";
import { readServeIntent, writeServeIntent } from "../../src/serve/intent";
import {
  SERVICE_BROKER_REAP_SECONDS, SERVICE_READY_SECONDS, SERVICE_START_SECONDS,
  SERVICE_STOP_SECONDS, systemdUnitName, systemdUnitPath,
} from "../../src/serve/units";
import { ensureVaultId } from "../../src/serve/vault-id";
import type { SupervisorKind, SupervisorState, SupervisorStatus } from "../../src/serve/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const mode of ["replace", "disable", "absent", "unknown", "timeout", "later-pid", "bootout-failure", "bootstrap-failure", "startup-delay", "startup-timeout", "startup-unknown"] as const) {
  test(`launchd replacement waits for observed removal: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-fixture-")); roots.push(root);
    const statePath = join(root, "state.json"), command = join(root, "launchctl");
    writeFileSync(statePath, JSON.stringify({ calls: [], stopping: false, observations: 0, activationObservations: 0, loaded: false, absent: false }), { mode: 0o600 });
    // A real disposable executable exercises the native spawn boundary. It never
    // invokes the platform service manager or depends on module-loader mocking.
    writeFileSync(command, `#!${process.execPath}
      import {readFileSync, writeFileSync} from 'node:fs';
      import assert from 'node:assert/strict';
      const mode = ${JSON.stringify(mode)}, path = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(path, 'utf8')), args = process.argv.slice(2);
      state.calls.push(args[0]);
      let code = 0, stdout = '', stderr = '';
      if (args[0] === 'print') {
        assert.equal(args[1], 'gui/' + process.getuid() + '/dev.kizuki.synthetic');
        if (state.loaded) {
          state.activationObservations++;
          if (mode === 'startup-unknown') { code = 1; stderr = 'synthetic inspection failure'; }
          else if (mode === 'startup-timeout' || (mode === 'startup-delay' && state.activationObservations < 3)) stdout = 'state = spawn scheduled';
          else stdout = 'state = running\\npid = 98765\\ndisabled = 0\\nenvironment = { SERVICE_DISABLED = 1 }';
        } else if (mode === 'absent' || mode.startsWith('startup-') || (state.stopping && !['unknown','timeout','later-pid'].includes(mode) && ++state.observations > 1)) {
          state.absent = true; code = 113; stderr = 'Could not find service "dev.kizuki.synthetic" in domain for user gui';
        } else if (state.stopping && mode === 'unknown') { code = 1; stderr = 'synthetic inspection failure'; }
        else stdout = 'state = running\\npid = ' + (state.stopping && mode === 'later-pid' ? 98765 : 5340) + '\\ndisabled = 0\\nenvironment = { SERVICE_DISABLED = 1 }';
      } else if (args[0] === 'bootout') {
        assert.equal(args[1], 'gui/' + process.getuid() + '/dev.kizuki.synthetic');
        state.stopping = true; code = mode === 'bootout-failure' ? 1 : 0;
      } else {
        assert.equal(args[0], 'bootstrap');
        assert.equal(args[1], 'gui/' + process.getuid());
        assert.equal(args[2], '/synthetic/unit.plist');
        assert.equal(state.absent, true, 'bootstrap must follow observed absence');
        code = mode === 'bootstrap-failure' ? 5 : 0;
        state.loaded = code === 0;
      }
      writeFileSync(path, JSON.stringify(state));
      process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code);
    `, {mode: 0o700});
    const script = `
      import {readFileSync} from 'node:fs';
      import assert from 'node:assert/strict';
      const mode = ${JSON.stringify(mode)}; let elapsed = 0;
      Object.defineProperty(performance, 'now', {value: () => elapsed});
      Atomics.wait = (_a, _b, _c, ms) => { elapsed += ['timeout','later-pid','startup-timeout'].includes(mode) ? 1000 : ms; return 'timed-out'; };
      const {realSupervisorHost} = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
      const host = realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki');
      assert.equal(host.query('synthetic').state, mode === 'absent' || mode.startsWith('startup-') ? 'absent' : 'active');
      const result = mode === 'disable' ? host.disable('dev.kizuki.synthetic') : host.enable('/synthetic/unit.plist', 'dev.kizuki.synthetic');
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      assert.equal(result.ok, ['replace','disable','absent','startup-delay'].includes(mode));
      assert.equal(state.calls.filter(call => call === 'bootstrap').length, ['replace','absent','bootstrap-failure','startup-delay','startup-timeout','startup-unknown'].includes(mode) ? 1 : 0);
      if (['replace','disable'].includes(mode)) assert.ok(state.observations > 1, 'old process must be observed before disappearance');
      if (['timeout','later-pid','startup-timeout'].includes(mode)) assert.equal(elapsed, 5000);
      if (mode === 'startup-delay') assert.ok(state.activationObservations >= 3, 'bootstrap acknowledgment must not stand in for a running process');
      if (mode === 'disable') assert.equal(state.absent, true);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: {...process.env, PATH: root + ':' + process.env.PATH}, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect({code: result.exitCode, stderr: result.stderr.toString()}).toEqual({code: 0, stderr: ""});
  });
}

function fixture(kind: SupervisorKind = "systemd") {
  const root = mkdtempSync(join(tmpdir(), "kizuki-supervisor-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault); writeServeIntent(vault, "opted-out");
  let state: SupervisorState = "absent";
  let enabled = false;
  const activated: string[] = [];
  const enabledWithoutStart: string[] = [];
  const host: SupervisorHost = {
    kind, home: root, execStart: ["/synthetic/kizuki-v1", "serve", "--vault", vault],
    query: () => ({ kind, state, unit: "synthetic", enabled, detail: state }),
    reload: () => ({ok: true, detail: "reloaded"}),
    enable: path => { activated.push(readFileSync(path, "utf8")); state = "active"; enabled = true; return { ok: true, detail: "active" }; },
    disable: () => { state = "disabled"; enabled = false; return { ok: true, detail: "disabled" }; },
    ...(kind === "systemd" ? {
      enableWithoutStart: (name: string) => { enabledWithoutStart.push(name); enabled = true; return { ok: true, detail: "enabled" }; },
    } : {}),
  };
  return {
    root, vault, host, activated, enabledWithoutStart,
    setState: (next: SupervisorState) => { state = next; enabled = next === "active"; },
    observe: (next: SupervisorState, nextEnabled: boolean) => { state = next; enabled = nextEnabled; },
  };
}

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

function journalPath(vault: string): string { return join(vault, ".kizuki", "service-change.json"); }

function withoutEnablementOnly(host: SupervisorHost): SupervisorHost {
  return { kind: host.kind, home: host.home, ...(host.configHome === undefined ? {} : { configHome: host.configHome }),
    execStart: host.execStart, query: host.query.bind(host), reload: host.reload.bind(host),
    enable: host.enable.bind(host), disable: host.disable.bind(host) };
}

function interruptInstall(f: ReturnType<typeof fixture>, status: Pick<SupervisorStatus, "state" | "enabled">): void {
  const code = `import { installServeService } from ${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))};
    installServeService(${JSON.stringify(f.vault)}, {
      kind: ${JSON.stringify(f.host.kind)}, home: ${JSON.stringify(f.root)}, execStart: ["/synthetic/kizuki-v2", "serve"],
      query: () => ({kind:${JSON.stringify(f.host.kind)},state:${JSON.stringify(status.state)},unit:"synthetic",enabled:${status.enabled},detail:${JSON.stringify(status.state)}}),
      reload: () => ({ok:true,detail:"reloaded"}), enable: () => process.exit(86), disable: () => ({ok:true,detail:"disabled"}),
      enableWithoutStart: () => ({ok:true,detail:"enabled"})
    });`;
  expect(Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(86);
}

test("activation failure does not record installed intent or leave a new unit", () => {
  const f = fixture(); f.host.enable = () => ({ ok: false, detail: "failed" });
  expect(() => installServeService(f.vault, f.host)).toThrow();
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(f.activated).toEqual([]);
});

test("a command reporting success without active enabled state is refused", () => {
  const f = fixture(); f.host.enable = () => ({ ok: true, detail: "claimed" });
  expect(() => installServeService(f.vault, f.host)).toThrow();
  expect(readServeIntent(f.vault)).toBe("opted-out");
});

test("upgrade failure restores the prior unit and active service", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  const enable = f.host.enable;
  const upgraded: SupervisorHost = { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"], enable: (path, name) => {
    if (readFileSync(path, "utf8").includes("kizuki-v2")) return { ok: false, detail: "failed" };
    return enable(path, name);
  } };
  expect(() => installServeService(f.vault, upgraded)).toThrow();
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(f.host.query("synthetic").state).toBe("active");
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("failed disable preserves the unit and installed intent", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  f.host.disable = () => ({ ok: false, detail: "failed" });
  expect(() => uninstallServeService(f.vault, f.host)).toThrow();
  expect(existsSync(first.unitPath!)).toBe(true);
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("unsafe existing unit is refused without following or replacing its target", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  rmSync(first.unitPath!); const target = join(f.root, "keep.txt"); writeFileSync(target, "unchanged");
  symlinkSync(target, first.unitPath!);
  expect(() => installServeService(f.vault, f.host)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("unchanged");
});

test("repeat install activates current bytes and uninstall proves disabled state", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const next = installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"] });
  expect(next.status.state).toBe("active");
  expect(f.activated.at(-1)).toContain("kizuki-v2");
  const removed = uninstallServeService(f.vault, f.host);
  expect(removed.removed).toBe(true);
  expect(existsSync(first.unitPath!)).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
});

test("process exit after unit publication preserves a durable rollback snapshot", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  const modulePath = join(import.meta.dir, "../../src/serve/supervisor.ts");
  const code = `import { installServeService } from ${JSON.stringify(modulePath)};
    installServeService(${JSON.stringify(f.vault)}, {
      kind: "systemd", home: ${JSON.stringify(f.root)}, execStart: ["/synthetic/kizuki-v2", "serve"],
      query: () => ({kind:"systemd",state:"active",unit:"synthetic",enabled:true,detail:"active"}),
      reload: () => ({ok:true,detail:"reloaded"}), enable: () => process.exit(86), disable: () => ({ok:true,detail:"disabled"})
    });`;
  const exited = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(exited.exitCode).toBe(86);
  const journal = join(f.vault, ".kizuki", "service-change.json");
  expect(JSON.parse(readFileSync(journal, "utf8")).previous_unit).toBe(original);
  const upgraded = installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"] });
  expect(upgraded.status.state).toBe("active");
  expect(f.activated.at(-2)).toBe(original);
  expect(f.activated.at(-1)).toContain("kizuki-v2");
  expect(existsSync(journal)).toBe(false);
});

test("a pending failed stop can be recovered by a later invocation", () => {
  const f = fixture(); installServeService(f.vault, f.host);
  const disable = f.host.disable;
  f.host.disable = () => ({ ok: false, detail: "failed" });
  expect(() => uninstallServeService(f.vault, f.host)).toThrow("recovery is pending");
  expect(existsSync(join(f.vault, ".kizuki", "service-change.json"))).toBe(true);
  f.host.disable = disable;
  expect(uninstallServeService(f.vault, f.host).removed).toBe(true);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(join(f.vault, ".kizuki", "service-change.json"))).toBe(false);
});

test("unknown prior supervision refuses upgrade and removal without touching the old definition", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  let mutations = 0;
  const unknown: SupervisorHost = { ...f.host,
    query: () => ({kind: "systemd", state: "unknown", unit: "synthetic", enabled: false, detail: "unavailable"}),
    enable: () => { mutations++; return {ok: false, detail: "failed"}; },
    disable: () => { mutations++; return {ok: true, detail: "disabled"}; },
  };
  expect(() => installServeService(f.vault, unknown)).toThrow("no service change made");
  expect(() => uninstallServeService(f.vault, unknown)).toThrow("no service change made");
  expect(mutations).toBe(0);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(readServeIntent(f.vault)).toBe("installed");
  expect(existsSync(join(f.vault, ".kizuki", "service-change.json"))).toBe(false);
});

test("recovery refuses identity or unit-location drift and retains the original pending journal", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const vaultIdPath = join(f.vault, ".kizuki", "vault-id");
  const originalId = readFileSync(vaultIdPath, "utf8");
  const code = `import { installServeService } from ${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))};
    installServeService(${JSON.stringify(f.vault)}, {
      kind: "systemd", home: ${JSON.stringify(f.root)}, execStart: ["/synthetic/kizuki-v2", "serve"],
      query: () => ({kind:"systemd",state:"active",unit:"synthetic",enabled:true,detail:"active"}),
      reload: () => ({ok:true,detail:"reloaded"}), enable: () => process.exit(86), disable: () => ({ok:true,detail:"disabled"})
    });`;
  expect(Bun.spawnSync([process.execPath, "-e", code], {stdout: "pipe", stderr: "pipe"}).exitCode).toBe(86);
  const journal = join(f.vault, ".kizuki", "service-change.json");
  const snapshot = readFileSync(journal, "utf8");
  const published = readFileSync(first.unitPath!, "utf8");
  let mutations = 0;
  const untouched = { ...f.host, enable: () => { mutations++; return {ok: true, detail: "active"}; },
    disable: () => { mutations++; return {ok: true, detail: "stopped"}; } };
  writeFileSync(vaultIdPath, "different-vault-id\n");
  expect(() => installServeService(f.vault, untouched)).toThrow("another vault or service location");
  expect(mutations).toBe(0);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(published);
  expect(readFileSync(journal, "utf8")).toBe(snapshot);
  writeFileSync(vaultIdPath, originalId);
  expect(() => installServeService(f.vault, {...untouched, configHome: join(f.root, "other-config")})).toThrow("another vault or service location");
  expect(mutations).toBe(0);
  expect(readFileSync(journal, "utf8")).toBe(snapshot);
  expect(installServeService(f.vault, f.host).status.state).toBe("active");
  expect(existsSync(journal)).toBe(false);
});

test("malformed intent and path-shaped vault IDs cannot initiate a service transaction", () => {
  const f = fixture();
  writeFileSync(join(f.vault, ".kizuki", "serve-intent"), "broken-intent\n");
  expect(() => installServeService(f.vault, f.host)).toThrow("service intent is invalid");
  expect(f.activated).toHaveLength(0);
  expect(existsSync(join(f.vault, ".kizuki", "service-change.json"))).toBe(false);
  writeServeIntent(f.vault, "opted-out");
  writeFileSync(join(f.vault, ".kizuki", "vault-id"), "../other\n");
  expect(() => installServeService(f.vault, f.host)).toThrow("invalid vault identity");
  expect(f.activated).toHaveLength(0);
});

test("rollback reloads restored disabled definitions without starting them", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.setState("disabled"); writeServeIntent(f.vault, "opted-out");
  let cached = original;
  const changed: SupervisorHost = {...f.host, execStart:["/synthetic/kizuki-v2","serve"],
    enable: path => {cached=readFileSync(path,"utf8");return {ok:false,detail:"activation failed"};},
    reload: () => {cached=readFileSync(first.unitPath!,"utf8");return {ok:true,detail:"reloaded"};},
  };
  expect(() => installServeService(f.vault, changed)).toThrow("previous configuration restored");
  expect(cached).toBe(original);
  expect(f.host.query("synthetic").state).toBe("disabled");
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(join(f.vault,".kizuki","service-change.json"))).toBe(false);
});

test("rollback reloads deletion of a failed first-install definition", () => {
  const f = fixture(); let path="", cached: string|null=null;
  const changed: SupervisorHost = {...f.host,
    enable: next => {path=next;cached=readFileSync(next,"utf8");return {ok:false,detail:"activation failed"};},
    reload: () => {cached=existsSync(path)?readFileSync(path,"utf8"):null;return {ok:true,detail:"reloaded"};},
  };
  expect(() => installServeService(f.vault, changed)).toThrow("previous configuration restored");
  expect(cached).toBe(null);
  expect(existsSync(path)).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(join(f.vault,".kizuki","service-change.json"))).toBe(false);
});

test("uninstall of an enabled inactive systemd unit confirms disable without activating", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  const before = ordinaryVault(f.vault);
  f.observe("disabled", true);
  const trace: string[] = [];
  const disable = f.host.disable;
  f.host.disable = name => {
    expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
    trace.push("disable before removal");
    return disable(name);
  };
  f.host.reload = () => {
    expect(f.host.query("synthetic")).toMatchObject({ state: "disabled", enabled: false });
    expect(existsSync(first.unitPath!)).toBe(false);
    trace.push("reload after removal");
    return { ok: true, detail: "reloaded" };
  };
  const removed = uninstallServeService(f.vault, f.host);
  expect(removed.removed).toBe(true);
  expect(removed.status.enabled).toBe(false);
  expect(["disabled", "absent", "masked"]).toContain(removed.status.state);
  expect(existsSync(first.unitPath!)).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(ordinaryVault(f.vault)).toEqual(before);
  expect(f.activated).toEqual([original]);
  expect(f.enabledWithoutStart).toEqual([]);
  expect(trace).toEqual(["disable before removal", "reload after removal"]);
});

for (const failure of ["disable", "reload"] as const) {
  test(`one failed ${failure} restores inactive enablement and the prior intent without activation`, () => {
    const f = fixture(); const first = installServeService(f.vault, f.host);
    const original = readFileSync(first.unitPath!, "utf8");
    f.observe("disabled", true);
    const before = ordinaryVault(f.vault);
    const operation = f.host[failure];
    let calls = 0;
    f.host[failure] = (name: string = "") => ++calls === 1
      ? { ok: false, detail: "ordinary operation failure" }
      : operation(name);
    expect(() => uninstallServeService(f.vault, f.host)).toThrow("previous configuration restored");
    expect(calls).toBe(2);
    expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
    expect(f.host.query("synthetic")).toMatchObject({ state: "disabled", enabled: true });
    expect(readServeIntent(f.vault)).toBe("installed");
    expect(existsSync(journalPath(f.vault))).toBe(false);
    expect(ordinaryVault(f.vault)).toEqual(before);
    expect(f.activated).toEqual([original]);
    expect(f.enabledWithoutStart).toHaveLength(1);
  });
}

test("failed disable of inactive+enabled stays pending and retry uninstalls without activation", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  const disable = f.host.disable;
  f.host.disable = () => ({ ok: false, detail: "failed" });
  expect(() => uninstallServeService(f.vault, f.host)).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(readServeIntent(f.vault)).toBe("installed");
  f.host.disable = disable;
  expect(uninstallServeService(f.vault, f.host).removed).toBe(true);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(f.activated).toEqual([original]);
});

test("failed removal reload of inactive+enabled stays pending and retry uninstalls without activation", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  f.host.reload = () => ({ ok: false, detail: "failed" });
  expect(() => uninstallServeService(f.vault, f.host)).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(readServeIntent(f.vault)).toBe("installed");
  f.host.reload = () => ({ ok: true, detail: "reloaded" });
  expect(uninstallServeService(f.vault, f.host).removed).toBe(true);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(first.unitPath!)).toBe(false);
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(f.activated).toEqual([original]);
});

test("failed enablement restoration retains pending recovery until retry converges", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  const enable = f.host.enable;
  f.host.enable = (path, name) => {
    if (readFileSync(path, "utf8").includes("kizuki-v2")) return { ok: false, detail: "failed" };
    return enable(path, name);
  };
  f.host.enableWithoutStart = () => ({ ok: false, detail: "failed" });
  expect(() => installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"] })).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(f.activated).toEqual([original]);
  f.host.enableWithoutStart = name => { f.enabledWithoutStart.push(name); f.observe("disabled", true); return { ok: true, detail: "enabled" }; };
  expect(uninstallServeService(f.vault, f.host).removed).toBe(true);
  expect(readServeIntent(f.vault)).toBe("opted-out");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(f.activated).toEqual([original]);
  expect(f.enabledWithoutStart.length).toBeGreaterThan(0);
});

test("explicit reinstall of inactive+enabled activates the current definition", () => {
  const f = fixture(); installServeService(f.vault, f.host);
  f.observe("disabled", true);
  const next = installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"] });
  expect(next.status.state).toBe("active");
  expect(next.status.enabled).toBe(true);
  expect(f.activated.at(-1)).toContain("kizuki-v2");
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("failed reinstall from inactive+enabled restores inactivity and enablement without starting", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  const enable = f.host.enable;
  const upgraded: SupervisorHost = { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"], enable: (path, name) => {
    if (readFileSync(path, "utf8").includes("kizuki-v2")) return { ok: false, detail: "failed" };
    return enable(path, name);
  } };
  expect(() => installServeService(f.vault, upgraded)).toThrow("previous configuration restored");
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(f.host.query("synthetic")).toMatchObject({ state: "disabled", enabled: true });
  expect(readServeIntent(f.vault)).toBe("installed");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(f.activated).toEqual([original]);
  expect(f.enabledWithoutStart.length).toBeGreaterThan(0);
});

test("valid version-2 active and disabled journals recover according to their original meaning", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  interruptInstall(f, { state: "active", enabled: true });
  const activeJournal = JSON.parse(readFileSync(journalPath(f.vault), "utf8"));
  expect(activeJournal.version).toBe(3);
  writeFileSync(journalPath(f.vault), JSON.stringify({
    version: 2, kind: "systemd", identity_hash: activeJournal.identity_hash,
    previous_unit: activeJournal.previous_unit, previous_intent: "installed", previous_enabled: true,
  }));
  f.setState("disabled"); // The post-interruption state does not redefine v2's prior activity.
  const recoveredActive = installServeService(f.vault, f.host);
  expect(recoveredActive.status.state).toBe("active");
  expect(f.activated.at(-2)).toBe(original);
  expect(existsSync(journalPath(f.vault))).toBe(false);

  f.setState("disabled"); writeServeIntent(f.vault, "opted-out");
  interruptInstall(f, { state: "disabled", enabled: false });
  const disabledJournal = JSON.parse(readFileSync(journalPath(f.vault), "utf8"));
  writeFileSync(journalPath(f.vault), JSON.stringify({
    version: 2, kind: "systemd", identity_hash: disabledJournal.identity_hash,
    previous_unit: disabledJournal.previous_unit, previous_intent: "opted-out", previous_enabled: false,
  }));
  f.setState("active");
  const beforeEnable = f.activated.length;
  let restoredUnit = "";
  let restoredStatus: SupervisorStatus | undefined;
  const recoveredDisabled = installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"],
    reload: () => { restoredUnit = readFileSync(first.unitPath!, "utf8"); restoredStatus = f.host.query("synthetic"); return { ok: true, detail: "reloaded" }; },
  });
  expect(restoredUnit).toBe(original);
  expect(restoredStatus).toMatchObject({ state: "disabled", enabled: false });
  expect(recoveredDisabled.status.state).toBe("active");
  expect(f.activated.length).toBe(beforeEnable + 1);
  expect(f.activated.at(-1)).toContain("kizuki-v2");
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("interrupted version-3 inactive+enabled snapshot preserves original activity on later invocation", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  interruptInstall(f, { state: "disabled", enabled: true });
  const snapshot = JSON.parse(readFileSync(journalPath(f.vault), "utf8"));
  expect(snapshot).toMatchObject({ version: 3, previous_enabled: true, previous_active: false, previous_intent: "installed" });
  expect(snapshot.previous_unit).toBe(original);
  let restored: SupervisorStatus | undefined;
  const next = installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"],
    enable: (path, name) => { restored = f.host.query("synthetic"); return f.host.enable(path, name); },
  });
  expect(restored).toMatchObject({ state: "disabled", enabled: true });
  expect(next.status.state).toBe("active");
  expect(f.activated.at(-1)).toContain("kizuki-v2");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(f.enabledWithoutStart.length).toBeGreaterThan(0);
});

test("hosts without enablement-only restoration refuse inactive+enabled before mutation and keep active flows", () => {
  const f = fixture(); const first = installServeService(f.vault, withoutEnablementOnly(f.host));
  expect(existsSync(first.unitPath!)).toBe(true);
  const next = installServeService(f.vault, { ...withoutEnablementOnly(f.host), execStart: ["/synthetic/kizuki-v2", "serve"] });
  expect(next.status.state).toBe("active");
  expect(uninstallServeService(f.vault, withoutEnablementOnly(f.host)).removed).toBe(true);
  expect(readServeIntent(f.vault)).toBe("opted-out");

  const g = fixture(); const installed = installServeService(g.vault, g.host);
  const owned = readFileSync(installed.unitPath!, "utf8");
  g.observe("disabled", true);
  let mutations = 0;
  const incapable: SupervisorHost = {
    ...withoutEnablementOnly(g.host),
    enable: (path, name) => { mutations++; return g.host.enable(path, name); },
    disable: name => { mutations++; return g.host.disable(name); },
  };
  expect(() => uninstallServeService(g.vault, incapable)).toThrow("no service change made");
  expect(() => installServeService(g.vault, incapable)).toThrow("no service change made");
  expect(mutations).toBe(0);
  expect(readFileSync(installed.unitPath!, "utf8")).toBe(owned);
  expect(readServeIntent(g.vault)).toBe("installed");
  expect(existsSync(journalPath(g.vault))).toBe(false);
  expect(g.host.query("synthetic")).toMatchObject({ state: "disabled", enabled: true });
});

test("pending inactive+enabled recovery with an incapable host stays pending without guessing", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  interruptInstall(f, { state: "disabled", enabled: true });
  const snapshot = readFileSync(journalPath(f.vault), "utf8");
  let mutations = 0;
  const incapable = withoutEnablementOnly({
    ...f.host,
    enable: (path, name) => { mutations++; return f.host.enable(path, name); },
    disable: name => { mutations++; return f.host.disable(name); },
  });
  expect(() => installServeService(f.vault, incapable)).toThrow("cannot restore enablement");
  expect(mutations).toBe(0);
  expect(readFileSync(journalPath(f.vault), "utf8")).toBe(snapshot);
  expect(readFileSync(first.unitPath!, "utf8")).not.toBe(original);
  expect(installServeService(f.vault, f.host).status.state).toBe("active");
  expect(existsSync(journalPath(f.vault))).toBe(false);
});

test("launchd recovery unloads a loaded inactive job before restoring", () => {
  const f = fixture("launchd");
  const first = installServeService(f.vault, f.host);
  interruptInstall(f, { state: "active", enabled: true });
  f.observe("disabled", true);
  let disables = 0;
  const host: SupervisorHost = {
    ...f.host,
    disable: (name) => { disables += 1; return f.host.disable(name); },
  };
  const resumed = installServeService(f.vault, {
    ...host,
    execStart: ["/synthetic/kizuki-v2", "serve"],
  });
  expect(resumed.status).toMatchObject({ state: "active", enabled: true });
  expect(disables).toBe(1);
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(readFileSync(first.unitPath!, "utf8")).toContain("kizuki-v2");
});

test("launchd loaded-but-inactive supervision is not admitted as inactive+enabled", () => {
  const f = fixture("launchd");
  const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  let mutations = 0;
  const host: SupervisorHost = { ...f.host,
    enable: (path, name) => { mutations++; return f.host.enable(path, name); },
    disable: name => { mutations++; return f.host.disable(name); },
  };
  expect(() => uninstallServeService(f.vault, host)).toThrow("no service change made");
  expect(() => installServeService(f.vault, host)).toThrow("no service change made");
  expect(mutations).toBe(0);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(readServeIntent(f.vault)).toBe("installed");
  expect(existsSync(journalPath(f.vault))).toBe(false);
});

test("enablement restoration that starts the unit remains unverified", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  f.observe("disabled", true);
  const enable = f.host.enable;
  f.host.enable = (path, name) => {
    if (readFileSync(path, "utf8").includes("kizuki-v2")) return { ok: false, detail: "failed" };
    return enable(path, name);
  };
  f.host.enableWithoutStart = name => { f.enabledWithoutStart.push(name); f.observe("active", true); return { ok: true, detail: "enabled" }; };
  expect(() => installServeService(f.vault, { ...f.host, execStart: ["/synthetic/kizuki-v2", "serve"] })).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(original);
  expect(f.activated).toEqual([original]);
});

test("unsupported journal shapes are retained without mutating the unit", () => {
  const f = fixture(); const first = installServeService(f.vault, f.host);
  const original = readFileSync(first.unitPath!, "utf8");
  interruptInstall(f, { state: "active", enabled: true });
  const valid = JSON.parse(readFileSync(journalPath(f.vault), "utf8"));
  let mutations = 0;
  const host: SupervisorHost = { ...f.host,
    reload: () => { mutations++; return f.host.reload(); },
    enable: (path, name) => { mutations++; return f.host.enable(path, name); },
    disable: name => { mutations++; return f.host.disable(name); },
  };
  for (const fields of [
    { extra: true },
    { version: 2 }, // v2 cannot carry the additional v3 activity field.
    { version: 4 },
    { previous_active: undefined },
    { previous_active: "false" },
    { previous_enabled: "true" },
    { previous_enabled: false, previous_active: true },
    { previous_unit: null, previous_enabled: true },
  ]) {
    const snapshot = JSON.stringify({ ...valid, ...fields });
    writeFileSync(journalPath(f.vault), snapshot);
    expect(() => installServeService(f.vault, host)).toThrow("another vault or service location");
    expect(mutations).toBe(0);
    expect(readFileSync(journalPath(f.vault), "utf8")).toBe(snapshot);
    expect(readFileSync(first.unitPath!, "utf8")).not.toBe(original);
  }
});

test("version-3 launchd journals cannot claim inactive enablement even with a capable host", () => {
  const f = fixture("launchd"); const first = installServeService(f.vault, f.host);
  interruptInstall(f, { state: "active", enabled: true });
  const prior = JSON.parse(readFileSync(journalPath(f.vault), "utf8"));
  const snapshot = JSON.stringify({ ...prior, previous_active: false });
  writeFileSync(journalPath(f.vault), snapshot);
  const published = readFileSync(first.unitPath!, "utf8");
  const calls: string[] = [];
  const host: SupervisorHost = { ...f.host,
    disable: name => { calls.push("disable"); return f.host.disable(name); },
    reload: () => { calls.push("reload"); return f.host.reload(); },
    enableWithoutStart: () => { calls.push("enable without start"); return { ok: true, detail: "enabled" }; },
  };
  expect(() => installServeService(f.vault, host)).toThrow("snapshot is invalid");
  expect(calls).toEqual([]);
  expect(readFileSync(journalPath(f.vault), "utf8")).toBe(snapshot);
  expect(readFileSync(first.unitPath!, "utf8")).toBe(published);
  expect(readServeIntent(f.vault)).toBe("installed");
});


const launchdCanary = "disabled PRIVATE_MANAGER_CANARY" as const;
for (const [name, stdout, code, state, detail, stderr] of [
  ["failed exit", "state = exited\nlast exit code = 78", 0, "disabled", "failed (last exit code 78)", launchdCanary],
  ["failed retry", "state = spawn scheduled\nlast exit code = 1", 0, "disabled", "failed (last exit code 1)", launchdCanary],
  ["clean stop", "state = not running\nlast exit code = 0", 0, "disabled", "stopped (last exit code 0)", launchdCanary],
  ["initial wait", "state = waiting", 0, "disabled", "loaded but not running", launchdCanary],
  ["active after failure", "state = running\npid = 98765\nlast exit code = 78", 0, "active", "active", launchdCanary],
  ["running with disabled = 0", "state = running\npid = 98765\ndisabled = 0", 0, "active", "active", launchdCanary],
  ["running with SERVICE_DISABLED", "state = running\npid = 98765\nenvironment = {\n\tSERVICE_DISABLED = 1\n}", 0, "active", "active", launchdCanary],
  ["stderr disabled substring", "state = running\npid = 98765", 0, "active", "active", "disabled in manager log"],
  ["anchored disabled", "disabled = 1\nstate = not running", 0, "disabled", "loaded but not running", launchdCanary],
  ["anchored disabled despite pid", "state = running\npid = 98765\ndisabled = 1", 0, "disabled", "loaded but not running", launchdCanary],
  ["malformed top-level disabled cannot activate", "state = running\npid = 98765\ndisabled = PRIVATE_MANAGER_CANARY", 0, "unknown", "supervisor state could not be queried", launchdCanary],
  ["anchored unloaded", "state = unloaded", 0, "disabled", "loaded but not running", launchdCanary],
  ["running without pid", "state = running\nlast exit code = 0", 0, "disabled", "loaded but not running", launchdCanary],
  ["non-running with pid", "state = waiting\npid = 98765", 0, "disabled", "loaded but not running", launchdCanary],
  ["nested running", "state = not running\nenvironment = {\n\tstate = running\n\tpid = 99\n}", 0, "disabled", "loaded but not running", launchdCanary],
  ["conflicting exit", "state = exited\nlast exit code = 78\nlast exit code = 0", 0, "disabled", "loaded but not running", launchdCanary],
  ["duplicate exit", "state = exited\nlast exit code = 78\nlast exit code = 78", 0, "disabled", "loaded but not running", launchdCanary],
  ["malformed exit", "state = exited\nlast exit code = PRIVATE_MANAGER_CANARY", 0, "disabled", "loaded but not running", launchdCanary],
  ["malformed sibling", "state = exited\nlast exit code = 78\nlast exit code=garbage", 0, "disabled", "loaded but not running", launchdCanary],
  ["malformed colon sibling", "state = exited\nlast exit code = 78\nlast exit code: 0", 0, "disabled", "loaded but not running", launchdCanary],
  ["oversized print", "state = exited\nlast exit code = 78\n" + "x".repeat(65_536), 0, "unknown", "supervisor state could not be queried", launchdCanary],
  ["unsafe exit", "state = exited\nlast exit code = 999999999999999999", 0, "disabled", "loaded but not running", launchdCanary],
  ["noncanonical exit", "state = exited\nlast exit code = 078", 0, "disabled", "loaded but not running", launchdCanary],
  ["out of range exit", "state = exited\nlast exit code = 256", 0, "disabled", "loaded but not running", launchdCanary],
  ["nested exit", "\tstate = exited\n\tenvironment = {\n\t\tlast exit code = 78\n\t}", 0, "disabled", "loaded but not running", launchdCanary],
  ["nested running failure", "state = running\nenvironment = {\n\tstate = exited\n\tlast exit code = 78\n}", 0, "disabled", "loaded but not running", launchdCanary],
  ["nested unloaded failure", "state = unloaded\nenvironment = {\n\tstate = exited\n\tlast exit code = 78\n}", 0, "disabled", "loaded but not running", launchdCanary],
  ["pid 1 is not a job", "state = running\npid = 1", 0, "disabled", "loaded but not running", launchdCanary],
  ["empty success", "", 0, "unknown", "supervisor state could not be queried", ""],
  ["unparseable success", "not a launchctl job record", 0, "unknown", "supervisor state could not be queried", ""],
  ["failed print", "state = exited\nlast exit code = 78", 1, "unknown", "supervisor state could not be queried", launchdCanary],
  ["failed print with job stdout", "state = running\npid = 98765", 1, "unknown", "supervisor state could not be queried", "Could not find service"],
  ["missing-service on stdout only", "Could not find service", 113, "unknown", "supervisor state could not be queried", ""],
  ["failed print without phrase", "", 113, "unknown", "supervisor state could not be queried", ""],
  ["unloaded service", "", 113, "absent", "absent", "Could not find service \"dev.kizuki.synthetic\" in domain for user gui; disabled"],
] as const) {
  test(`launchd status distinguishes ${name} with bounded diagnostics only`, () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-status-")); roots.push(root);
    writeFileSync(join(root, "launchctl"), `#!${process.execPath}\nimport assert from 'node:assert/strict';
      assert.deepEqual(process.argv.slice(2), ['print', 'gui/' + process.getuid() + '/dev.kizuki.synthetic']);
      process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});
`, { mode: 0o700 });
    const script = `const {realSupervisorHost} = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
      console.log(JSON.stringify(realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki').query('synthetic')));`;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
    const status = JSON.parse(result.stdout.toString());
    expect(status).toEqual({
      kind: "launchd", unit: "dev.kizuki.synthetic",
      enabled: state === "active" || state === "disabled", state, detail,
    });
    expect(result.stdout.toString()).not.toContain("PRIVATE_MANAGER_CANARY");
  });
}

test("public install confirms launchd running pid despite disabled substrings", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-install-")); roots.push(root);
  const vault = join(root, "vault"), home = join(root, "home"), statePath = join(root, "state.json");
  initVault(vault); writeServeIntent(vault, "opted-out");
  writeFileSync(statePath, JSON.stringify({ loaded: false }), { mode: 0o600 });
  writeFileSync(join(root, "launchctl"), `#!${process.execPath}
    import {readFileSync, writeFileSync} from 'node:fs';
    const path = ${JSON.stringify(statePath)};
    const state = JSON.parse(readFileSync(path, 'utf8')), args = process.argv.slice(2);
    let code = 0, stdout = '', stderr = '';
    if (args[0] === 'print') {
      if (!state.loaded) { code = 113; stderr = 'Could not find service in domain for user gui'; }
      else stdout = 'state = running\\npid = 98765\\ndisabled = 0\\nenvironment = { SERVICE_DISABLED = 1 }';
    } else if (args[0] === 'bootstrap') { state.loaded = true; }
    else if (args[0] === 'bootout') { state.loaded = false; }
    else code = 1;
    writeFileSync(path, JSON.stringify(state));
    process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code);
  `, { mode: 0o700 });
  const script = `
    import assert from 'node:assert/strict';
    const {realSupervisorHost, installServeService} = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
    const result = installServeService(${JSON.stringify(vault)}, realSupervisorHost('launchd', ${JSON.stringify(home)}, '/synthetic/kizuki'));
    assert.equal(result.status.state, 'active');
    assert.equal(result.status.enabled, true);
    assert.equal(result.wrote, true);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});

for (const [name, stdout, code, stderr] of [
  ["nested running failure", "state = running\nenvironment = {\n\tstate = exited\n\tlast exit code = 78\n}", 0, ""],
  ["nested unloaded failure", "state = unloaded\nenvironment = {\n\tstate = exited\n\tlast exit code = 78\n}", 0, ""],
  ["failed print with job stdout", "state = running\npid = 98765", 1, "Could not find service"],
  ["empty success", "", 0, ""],
] as const) {
  test(`launchd uninstall refuses ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-refuse-")); roots.push(root);
    const vault = join(root, "vault"), home = join(root, "home"), statePath = join(root, "state.json");
    initVault(vault); writeServeIntent(vault, "opted-out");
    writeFileSync(statePath, JSON.stringify({ loaded: false, probe: false }), { mode: 0o600 });
    writeFileSync(join(root, "launchctl"), `#!${process.execPath}
      import {readFileSync, writeFileSync} from 'node:fs';
      const path = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(path, 'utf8')), args = process.argv.slice(2);
      let code = 0, stdout = '', stderr = '';
      if (args[0] === 'print') {
        if (state.probe) { stdout = ${JSON.stringify(stdout)}; stderr = ${JSON.stringify(stderr)}; code = ${code}; }
        else if (!state.loaded) { code = 113; stderr = 'Could not find service in domain for user gui'; }
        else stdout = 'state = running\\npid = 98765\\ndisabled = 0';
      } else if (args[0] === 'bootstrap') { state.loaded = true; }
      else if (args[0] === 'bootout') { state.loaded = false; }
      else code = 1;
      writeFileSync(path, JSON.stringify(state));
      process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code);
    `, { mode: 0o700 });
    const script = `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      const { realSupervisorHost, installServeService, uninstallServeService } = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
      const host = realSupervisorHost('launchd', ${JSON.stringify(home)}, '/synthetic/kizuki');
      const installed = installServeService(${JSON.stringify(vault)}, host);
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ ...state, probe: true }));
      assert.throws(() => uninstallServeService(${JSON.stringify(vault)}, host), /no service change made/);
      assert.equal(existsSync(installed.unitPath), true);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  });
}

test("killed launchd print is unknown even with missing-service text", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-killed-")); roots.push(root);
  writeFileSync(join(root, "launchctl"), `#!${process.execPath}
    process.stdout.write('state = running\\npid = 98765\\n');
    process.stderr.write('Could not find service\\n');
    process.kill(process.pid, 'SIGKILL');
  `, { mode: 0o700 });
  const script = `
    import assert from 'node:assert/strict';
    const { realSupervisorHost } = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
    const status = realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki').query('synthetic');
    assert.equal(status.state, 'unknown');
    assert.equal(status.enabled, false);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});

test("launchd wait does not treat a killed missing-service print as absence", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-killed-wait-")); roots.push(root);
  writeFileSync(join(root, "launchctl"), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === 'bootout') process.exit(0);
    process.stderr.write('Could not find service\\n');
    process.kill(process.pid, 'SIGKILL');
  `, { mode: 0o700 });
  const script = `
    import assert from 'node:assert/strict';
    let elapsed = 0;
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    Atomics.wait = (_a, _b, _c, ms) => { elapsed += 1000; return 'timed-out'; };
    const { realSupervisorHost } = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
    const result = realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki').disable('dev.kizuki.synthetic');
    assert.equal(result.ok, false);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});

test("timed-out launchd print is not parsed as absence", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-timeout-print-")); roots.push(root);
  writeFileSync(join(root, "launchctl"), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === 'bootout') process.exit(0);
    process.stderr.write('Could not find service in domain for user gui\\n');
    setTimeout(() => process.exit(0), 1_000);
  `, { mode: 0o700 });
  const script = `
    import assert from 'node:assert/strict';
    let elapsed = 4900;
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    Atomics.wait = (_a, _b, _c, ms) => { elapsed += 1000; return 'timed-out'; };
    const { realSupervisorHost } = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
    const result = realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki').disable('dev.kizuki.synthetic');
    assert.equal(result.ok, false);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});

test("launchd wait does not admit a missing-service result after the deadline", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-launchd-late-")); roots.push(root);
  const receipt = join(root, "printed");
  writeFileSync(join(root, "launchctl"), `#!${process.execPath}
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] === 'bootout') process.exit(0);
    writeFileSync(${JSON.stringify(receipt)}, 'printed');
    process.stderr.write('Could not find service in domain for user gui\\n');
    process.exit(113);
  `, { mode: 0o700 });
  const script = `
    import { existsSync } from 'node:fs';
    import assert from 'node:assert/strict';
    let n = 0;
    Object.defineProperty(performance, 'now', { value: () => ++n <= 2 ? 0 : 5001 });
    const { realSupervisorHost } = await import(${JSON.stringify(join(import.meta.dir, "../../src/serve/supervisor.ts"))});
    const result = realSupervisorHost('launchd', '/synthetic', '/synthetic/kizuki').disable('dev.kizuki.synthetic');
    assert.equal(result.ok, false);
    assert.equal(existsSync(${JSON.stringify(receipt)}), true);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
});


test("uninstall of a positively observed failed launchd job removes it without starting it", () => {
  const f = fixture("launchd"), installed = installServeService(f.vault, f.host);
  f.observe("disabled", true);
  const query = f.host.query; f.host.query = id => { const row = query(id); return row.enabled && row.state === "disabled" ? { ...row, detail: "failed (last exit code 2)" } : row; };
  const disable = f.host.disable; f.host.disable = unit => { const result = disable(unit); f.observe("absent", false); return result; };
  const starts = f.activated.length;
  expect(uninstallServeService(f.vault, f.host).removed).toBe(true);
  expect(f.activated.length).toBe(starts);
  expect(existsSync(installed.unitPath!)).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
});


function failedLaunchdFixture() {
  const f = fixture("launchd"), installed = installServeService(f.vault, f.host);
  f.observe("disabled", true);
  const query = f.host.query;
  f.host.query = id => { const row = query(id); return row.enabled && row.state === "disabled" ? { ...row, detail: "failed (last exit code 2)" } : row; };
  f.host.disable = () => { f.observe("absent", false); return { ok: true, detail: "unloaded" }; };
  return { ...f, path: installed.unitPath!, journal: join(f.vault, ".kizuki/service-change.json") };
}

test("failed launchd stop persists an exact forward decision and retry never starts the job", () => {
  const f = failedLaunchdFixture(), original = readFileSync(f.path, "utf8"), disable = f.host.disable;
  f.host.disable = () => ({ ok: false, detail: "failed" });
  expect(() => uninstallServeService(f.vault, f.host)).toThrow("uninstall is pending");
  const entry = JSON.parse(readFileSync(f.journal, "utf8"));
  expect(Object.keys(entry).sort()).toEqual(["identity_hash", "kind", "operation", "previous_intent", "previous_unit", "version"]);
  expect(entry).toMatchObject({ version: 4, kind: "launchd", operation: "uninstall", previous_unit: original, previous_intent: "installed" });
  expect(readFileSync(f.path, "utf8")).toBe(original);
  f.host.disable = disable;
  uninstallServeService(f.vault, f.host);
  expect(f.activated).toHaveLength(1); expect(existsSync(f.path)).toBe(false); expect(existsSync(f.journal)).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
});

for (const point of ["after-stop", "after-remove"] as const) {
  test(`actual process exit ${point} resumes durable launchd removal without bootstrap`, () => {
    const f = failedLaunchdFixture(), module = join(import.meta.dir, "../../src/serve/supervisor.ts");
    const script = `
      import { uninstallServeService } from ${JSON.stringify(module)};
      let stopped = false;
      uninstallServeService(${JSON.stringify(f.vault)}, { kind:'launchd', home:${JSON.stringify(f.root)}, execStart:['/synthetic/kizuki-v1','serve'],
        query: () => ({kind:'launchd',state:stopped?'absent':'disabled',enabled:!stopped,unit:'synthetic',detail:stopped?'absent':'failed (last exit code 2)'}),
        disable: () => { stopped=true; ${point === "after-stop" ? "process.exit(86);" : ""} return {ok:true,detail:'stopped'}; },
        reload: () => { process.exit(87); }, enable: () => { process.exit(99); } });
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect({ exit: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exit: point === "after-stop" ? 86 : 87, stderr: "" });
    expect(JSON.parse(readFileSync(f.journal, "utf8")).operation).toBe("uninstall");
    expect(existsSync(f.path)).toBe(point === "after-stop");
    f.observe("absent", false); uninstallServeService(f.vault, f.host);
    expect(f.activated).toHaveLength(1); expect(existsSync(f.path)).toBe(false); expect(existsSync(f.journal)).toBe(false);
    expect(readServeIntent(f.vault)).toBe("opted-out");
  });
}

for (const fault of ["identity", "kind", "operation", "extra", "replacement"] as const) {
  test(`pending forward removal refuses ${fault} and preserves its journal and unrelated bytes`, () => {
    const f = failedLaunchdFixture(); f.host.disable = () => ({ ok:false,detail:'failed' });
    expect(() => uninstallServeService(f.vault, f.host)).toThrow("uninstall is pending");
    const entry = JSON.parse(readFileSync(f.journal, "utf8"));
    if (fault === "identity") entry.identity_hash = "foreign";
    if (fault === "kind") entry.kind = "systemd";
    if (fault === "operation") entry.operation = "install";
    if (fault === "extra") entry.extra = true;
    if (fault === "replacement") writeFileSync(f.path, "unrelated replacement", { mode:0o600 });
    writeFileSync(f.journal, JSON.stringify(entry), { mode:0o600 });
    const before = readFileSync(f.path, "utf8"), journal = readFileSync(f.journal, "utf8"); let calls=0;
    f.host.disable = () => { calls++; return {ok:true,detail:'unexpected'}; };
    expect(() => uninstallServeService(f.vault, f.host)).toThrow();
    expect(calls).toBe(0); expect(readFileSync(f.path,"utf8")).toBe(before); expect(readFileSync(f.journal,"utf8")).toBe(journal);
    expect(f.activated).toHaveLength(1);
  });
}

test("forward removal refuses a definition replaced during stop and preserves pending authority", () => {
  const f=failedLaunchdFixture();
  f.host.disable=()=>{ writeFileSync(f.path,"replacement during stop",{mode:0o600}); f.observe("absent",false); return {ok:true,detail:"unloaded"}; };
  expect(()=>uninstallServeService(f.vault,f.host)).toThrow("uninstall is pending");
  expect(readFileSync(f.path,"utf8")).toBe("replacement during stop"); expect(existsSync(f.journal)).toBe(true); expect(readServeIntent(f.vault)).toBe("installed");
});

test("later explicit install completes pending forward removal before one requested activation", () => {
  const f=failedLaunchdFixture(); f.host.reload=()=>({ok:false,detail:"failed"});
  expect(()=>uninstallServeService(f.vault,f.host)).toThrow("uninstall is pending");
  expect(existsSync(f.path)).toBe(false); expect(existsSync(f.journal)).toBe(true);
  f.host.reload=()=>({ok:true,detail:"reloaded"});
  installServeService(f.vault,f.host);
  expect(f.activated).toHaveLength(2); expect(readServeIntent(f.vault)).toBe("installed"); expect(existsSync(f.journal)).toBe(false);
});

for (const detail of ["loaded but not running", "stopped (last exit code 0)", "failed (last exit code 0)", "failed (last exit code 256)", "failed (last exit code 02)", "failed (last exit code 2) trailing"]) {
  test(`launchd forward removal never admits ambiguous state ${detail}`, () => {
    const f=failedLaunchdFixture(),query=f.host.query;
    f.host.query=id=>({...query(id),detail}); let calls=0; f.host.disable=()=>{calls++;return{ok:true,detail:"unexpected"};};
    expect(()=>uninstallServeService(f.vault,f.host)).toThrow("no service change made");
    expect(calls).toBe(0); expect(existsSync(f.journal)).toBe(false); expect(existsSync(f.path)).toBe(true);
  });
}

test("forward uninstall requires the host and observed status to agree on launchd", () => {
  const f=fixture("systemd"),installed=installServeService(f.vault,f.host);
  const original=readFileSync(installed.unitPath!,"utf8"); let mutations=0;
  const mixed: SupervisorHost={...f.host,
    query:()=>({kind:"launchd",state:"disabled",enabled:true,unit:"synthetic",detail:"failed (last exit code 2)"}),
    disable:()=>{mutations++;return{ok:false,detail:"unexpected"};}};
  expect(()=>uninstallServeService(f.vault,mixed)).toThrow("no service change made");
  expect(mutations).toBe(0); expect(existsSync(join(f.vault,".kizuki/service-change.json"))).toBe(false);
  expect(readFileSync(installed.unitPath!,"utf8")).toBe(original);
});

for (const mode of ["retained-failure", "reset-failure", "reset-no-transition", "reset-reactivates", "rollback-failure", "ordinary"] as const) {
  test(`systemd uninstall clears only the stopped owned failure before deletion: ${mode}`, () => {
    const f = fixture(); const first = installServeService(f.vault, f.host);
    const original = readFileSync(first.unitPath!, "utf8");
    const ordinary = ordinaryVault(f.vault);
    const unit = first.unitPath!.split("/").at(-1)!;
    const statePath = join(f.root, "systemd-state.json");
    writeFileSync(statePath, JSON.stringify({ mode, enabled: true, failed: mode !== "ordinary", calls: [] }), {mode: 0o600});
    writeFileSync(join(f.root, "systemctl"), `#!${process.execPath}
      import {existsSync,readFileSync,writeFileSync} from 'node:fs';
      import assert from 'node:assert/strict';
      const path=${JSON.stringify(statePath)}, unitPath=${JSON.stringify(first.unitPath)}, unit=${JSON.stringify(unit)};
      const s=JSON.parse(readFileSync(path,'utf8')), args=process.argv.slice(2), command=args[1];
      assert.equal(args[0],'--user');
      assert.deepEqual(args, command==='daemon-reload' ? ['--user',command] : command==='disable' ? ['--user','disable','--now',unit] : ['--user',command,unit]);
      s.calls.push(command); let code=0, output='';
      if(command==='is-enabled') { output=existsSync(unitPath) ? (s.enabled?'enabled':'disabled') : 'not-found'; code=output==='enabled'?0:output==='not-found'?4:1; }
      else if(command==='is-active') { output=s.active?'active':s.failed?'failed':'inactive'; code=s.active?0:existsSync(unitPath)?3:4; }
      else if(command==='disable') { s.enabled=false; s.active=false; }
      else if(command==='reset-failed') {
        assert.equal(existsSync(unitPath),true,'reset must precede owned definition removal');
        assert.equal(s.enabled,false,'reset must follow confirmed disable');
        assert.equal(s.failed,true);
        if(['reset-failure','rollback-failure'].includes(s.mode))code=1;
        else if(s.mode!=='reset-no-transition')s.failed=false;
        if(s.mode==='reset-reactivates')s.active=true;
      } else if(command==='enable') { if(s.mode==='rollback-failure')code=1; else s.enabled=true; }
      else assert.equal(command,'daemon-reload','uninstall must never start or restart');
      writeFileSync(path,JSON.stringify(s)); process.stdout.write(output); process.exit(code);
    `, {mode: 0o700});
    const script=`
      import {realSupervisorHost,uninstallServeService} from ${JSON.stringify(join(import.meta.dir,"../../src/serve/supervisor.ts"))};
      const host=realSupervisorHost('systemd',${JSON.stringify(f.root)},'/synthetic/kizuki');
      try { console.log(JSON.stringify({result:uninstallServeService(${JSON.stringify(f.vault)},host)})); }
      catch(error) { console.log(JSON.stringify({error:error.message})); }
    `;
    const result=Bun.spawnSync([process.execPath,'-e',script], {env:{...process.env,PATH:f.root+':'+process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:15_000});
    expect({code:result.exitCode,stderr:result.stderr.toString()}).toEqual({code:0,stderr:""});
    const observed=JSON.parse(result.stdout.toString());
    const state=JSON.parse(readFileSync(statePath,'utf8'));
    if(mode==='retained-failure'||mode==='ordinary') {
      expect(observed.error).toBeUndefined(); expect(observed.result.removed).toBe(true);
      expect(observed.result.status.state).toBe('absent'); expect(observed.result.status.enabled).toBe(false);
      expect(existsSync(first.unitPath!)).toBe(false); expect(readServeIntent(f.vault)).toBe('opted-out');
      expect(state.calls.filter((c:string)=>c==='reset-failed').length).toBe(mode==='ordinary'?0:1);
      expect(state.calls.includes('enable')).toBe(false);
    } else {
      expect(observed.error).toContain(mode==='rollback-failure'?'recovery is pending':'previous configuration restored');
      expect(readFileSync(first.unitPath!,'utf8')).toBe(original); expect(readServeIntent(f.vault)).toBe('installed');
      expect(existsSync(journalPath(f.vault))).toBe(mode==='rollback-failure');
      expect(state.calls.filter((c:string)=>c==='reset-failed').length).toBe(1);
    }
    expect(ordinaryVault(f.vault)).toEqual(ordinary);
    if (mode === "rollback-failure") {
      writeFileSync(statePath, JSON.stringify({...state, mode: "retained-failure"}));
      const retry=Bun.spawnSync([process.execPath,'-e',script], {env:{...process.env,PATH:f.root+':'+process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:15_000});
      expect({code:retry.exitCode,stderr:retry.stderr.toString()}).toEqual({code:0,stderr:""});
      expect(JSON.parse(retry.stdout.toString()).result.removed).toBe(true);
      expect(existsSync(journalPath(f.vault))).toBe(false); expect(existsSync(first.unitPath!)).toBe(false);
      expect(readServeIntent(f.vault)).toBe('opted-out'); expect(ordinaryVault(f.vault)).toEqual(ordinary);
    }
  });
}

for (const owned of [true, false]) {
  test(`failed systemd uninstall refuses unavailable reset capability or definition: owned=${owned}`, () => {
    const f = fixture(); const first = installServeService(f.vault, f.host);
    f.observe("disabled", false);
    const query = f.host.query;
    f.host.query = id => ({...query(id), detail: "failed"});
    let resets = 0;
    if (!owned) {
      rmSync(first.unitPath!);
      f.host.resetFailure = () => { resets++; return {ok:true, detail:"unexpected"}; };
    }
    expect(() => uninstallServeService(f.vault, f.host)).toThrow("previous configuration restored");
    expect(resets).toBe(0); expect(existsSync(first.unitPath!)).toBe(owned);
    expect(readServeIntent(f.vault)).toBe("installed");
  });
}

const LIFECYCLE_CLIENT_OVERLAP_MS = 6_000;
const REAL_CLIENT_CASE_MS = 20_000;

test("systemd client deadlines cover READY plus reap, stop, and restart without 100s tests", () => {
  expect(SERVICE_START_SECONDS).toBe(SERVICE_READY_SECONDS + SERVICE_BROKER_REAP_SECONDS + 1);
  expect(SYSTEMD_START_TIMEOUT_MS).toBe(SERVICE_START_SECONDS * 1_000 + SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(SYSTEMD_STOP_TIMEOUT_MS).toBe(SERVICE_STOP_SECONDS * 1_000 + SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(SYSTEMD_RESTART_TIMEOUT_MS).toBe(SYSTEMD_STOP_TIMEOUT_MS + SYSTEMD_START_TIMEOUT_MS - SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(SYSTEMD_START_TIMEOUT_MS).toBeGreaterThan((SERVICE_READY_SECONDS + SERVICE_BROKER_REAP_SECONDS) * 1_000);
  expect(SYSTEMD_STOP_TIMEOUT_MS).toBeGreaterThan(SERVICE_STOP_SECONDS * 1_000);
  expect(systemdCommandTimeoutMs("is-active")).toBe(SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(systemdCommandTimeoutMs("daemon-reload")).toBe(SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(systemdCommandTimeoutMs("start")).toBe(SYSTEMD_START_TIMEOUT_MS);
  expect(systemdCommandTimeoutMs("stop")).toBe(SYSTEMD_STOP_TIMEOUT_MS);
  expect(systemdCommandTimeoutMs("disable")).toBe(SYSTEMD_STOP_TIMEOUT_MS);
  expect(systemdCommandTimeoutMs("restart")).toBe(SYSTEMD_RESTART_TIMEOUT_MS);
  expect(LIFECYCLE_CLIENT_OVERLAP_MS).toBeGreaterThan(SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(LIFECYCLE_CLIENT_OVERLAP_MS).toBeLessThan(SYSTEMD_START_TIMEOUT_MS);
  expect(REAL_CLIENT_CASE_MS).toBeLessThan(100_000);
});

test("systemd start waits past the default command timeout without rollback", () => {
  const f = fixture();
  const vaultId = ensureVaultId(f.vault);
  const unit = systemdUnitName(vaultId);
  const unitPath = systemdUnitPath(f.root, vaultId);
  const statePath = join(f.root, "systemd-state.json");
  writeFileSync(statePath, JSON.stringify({ enabled: false, active: false, calls: [] }), { mode: 0o600 });
  writeFileSync(join(f.root, "systemctl"), `#!${process.execPath}
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import assert from 'node:assert/strict';
    const path=${JSON.stringify(statePath)}, unitPath=${JSON.stringify(unitPath)}, unit=${JSON.stringify(unit)};
    const s=JSON.parse(readFileSync(path,'utf8')), args=process.argv.slice(2), command=args[1];
    assert.equal(args[0],'--user');
    assert.deepEqual(args, command==='daemon-reload' ? ['--user',command] : command==='disable' ? ['--user','disable','--now',unit] : ['--user',command,unit]);
    s.calls.push(command); let code=0, output='';
    if(command==='is-enabled') { output=existsSync(unitPath) ? (s.enabled?'enabled':'disabled') : 'not-found'; code=output==='enabled'?0:output==='not-found'?4:1; }
    else if(command==='is-active') { output=s.active?'active':'inactive'; code=s.active?0:existsSync(unitPath)?3:4; }
    else if(command==='enable') s.enabled=true;
    else if(command==='stop') s.active=false;
    else if(command==='start') {
      s.enabled=true; s.active=true; writeFileSync(path,JSON.stringify(s));
      Bun.sleepSync(${LIFECYCLE_CLIENT_OVERLAP_MS});
    } else assert.equal(command,'daemon-reload');
    writeFileSync(path,JSON.stringify(s)); process.stdout.write(output); process.exit(code);
  `, { mode: 0o700 });
  const script = `
    import {readFileSync} from 'node:fs';
    import {installServeService,realSupervisorHost} from ${JSON.stringify(join(import.meta.dir,"../../src/serve/supervisor.ts"))};
    import {readServeIntent} from ${JSON.stringify(join(import.meta.dir,"../../src/serve/intent.ts"))};
    const host=realSupervisorHost('systemd',${JSON.stringify(f.root)},${JSON.stringify(f.host.execStart)});
    try {
      const installed=installServeService(${JSON.stringify(f.vault)},host);
      console.log(JSON.stringify({installed:installed.status,intent:readServeIntent(${JSON.stringify(f.vault)}),calls:JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8')).calls}));
    } catch(error) { console.log(JSON.stringify({error:error.message,intent:readServeIntent(${JSON.stringify(f.vault)})})); }
  `;
  const started = Date.now();
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, PATH: f.root + ":" + (process.env.PATH ?? "/usr/bin:/bin") },
    stdout: "pipe", stderr: "pipe", timeout: REAL_CLIENT_CASE_MS,
  });
  expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  expect(Date.now() - started).toBeGreaterThan(SUPERVISOR_COMMAND_TIMEOUT_MS);
  const observed = JSON.parse(result.stdout.toString());
  expect(observed.error).toBeUndefined();
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(observed.intent).toBe("installed");
  expect(observed.installed).toMatchObject({ state: "active", enabled: true });
  expect(existsSync(unitPath)).toBe(true);
  expect(readServeIntent(f.vault)).toBe("installed");
  const startAt = observed.calls.indexOf("start");
  expect(observed.calls.indexOf("stop")).toBeGreaterThan(-1);
  expect(startAt).toBeGreaterThan(observed.calls.indexOf("stop"));
}, REAL_CLIENT_CASE_MS);

function okResult(stdout = ""): SupervisorCommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", timedOut: false };
}
function failResult(stdout = "", exitCode: number | null = 1): SupervisorCommandResult {
  return { ok: false, exitCode, stdout, stderr: "", timedOut: false };
}

function systemdAdapter(handler: (command: string, timeout: number, argv: readonly string[]) => SupervisorCommandResult): {
  adapter: SupervisorTimeoutAdapter; now: { value: number }; timeouts: Record<string, number>;
} {
  const now = { value: 0 };
  const timeouts: Record<string, number> = {};
  return {
    now, timeouts,
    adapter: {
      now: () => now.value,
      run(argv, timeout) {
        const command = argv[2] ?? "";
        timeouts[command] = timeout;
        return handler(command, timeout, argv);
      },
    },
  };
}

test("adapter restart stops before start and budgets query/reload at 5s", () => {
  const f = fixture();
  const calls: string[] = [];
  let enabled = false, active = false, activity = "inactive";
  const { adapter, timeouts } = systemdAdapter((command) => {
    calls.push(command);
    if (command === "daemon-reload" || command === "enable") { if (command === "enable") enabled = true; return okResult(); }
    if (command === "stop") { active = false; activity = "inactive"; return okResult(); }
    if (command === "start") { enabled = true; active = true; activity = "active"; return okResult(); }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
    if (command === "is-active") return active ? okResult("active") : failResult(activity, activity === "inactive" ? 3 : 4);
    return failResult();
  });
  const host = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter });
  const installed = installServeService(f.vault, host);
  expect(installed.status).toMatchObject({ state: "active", enabled: true });
  expect(calls.indexOf("start")).toBeGreaterThan(calls.indexOf("stop"));
  expect(calls.includes("restart")).toBe(false);
  expect(timeouts["is-active"]).toBe(SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(timeouts["daemon-reload"]).toBe(SUPERVISOR_COMMAND_TIMEOUT_MS);
  expect(timeouts.stop).toBe(SYSTEMD_STOP_TIMEOUT_MS);
  expect(timeouts.start).toBe(SYSTEMD_START_TIMEOUT_MS);
});

test("client timeout while activating keeps the journal and does not inverse rollback", () => {
  const f = fixture();
  const calls: string[] = [];
  let enabled = false, activity = "inactive";
  const { adapter, now } = systemdAdapter((command) => {
    calls.push(command);
    if (command === "daemon-reload" || command === "enable" || command === "stop") {
      if (command === "enable") enabled = true;
      return okResult();
    }
    if (command === "start") {
      activity = "activating";
      now.value += SYSTEMD_START_TIMEOUT_MS;
      return failResult("", null);
    }
    if (command === "disable") return okResult();
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
    if (command === "is-active") {
      if (activity === "activating") return failResult("activating", 3);
      if (activity === "active") return okResult("active");
      return failResult(activity, 3);
    }
    return failResult();
  });
  const host = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter });
  expect(() => installServeService(f.vault, host)).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(host.query(ensureVaultId(f.vault))).toMatchObject({ state: "unknown", enabled: true, detail: "activating" });
  expect(calls.includes("disable")).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
});

test("client timeout while deactivating keeps the journal and does not inverse rollback", () => {
  const f = fixture();
  installServeService(f.vault, f.host);
  const calls: string[] = [];
  let enabled = true, activity = "active";
  const { adapter, now } = systemdAdapter((command) => {
    calls.push(command);
    if (command === "daemon-reload") return okResult();
    if (command === "enable") { enabled = true; return okResult(); }
    if (command === "disable") {
      activity = "deactivating";
      now.value += SYSTEMD_STOP_TIMEOUT_MS;
      return failResult("", null);
    }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("disabled", 1);
    if (command === "is-active") {
      if (activity === "deactivating") return failResult("deactivating", 3);
      if (activity === "active") return okResult("active");
      return failResult("inactive", 3);
    }
    return failResult();
  });
  const host = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter });
  expect(() => uninstallServeService(f.vault, host)).toThrow("recovery is pending");
  expect(existsSync(journalPath(f.vault))).toBe(true);
  expect(host.query(ensureVaultId(f.vault))).toMatchObject({ state: "unknown", enabled: true, detail: "deactivating" });
  expect(calls.filter(command => command === "disable")).toHaveLength(1);
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("confirmed start failure still rolls back; timeout is not that failure", () => {
  const f = fixture();
  let enabled = false, activity = "inactive";
  const { adapter } = systemdAdapter((command) => {
    if (command === "daemon-reload" || command === "enable" || command === "stop") {
      if (command === "enable") enabled = true;
      return okResult();
    }
    if (command === "start") { activity = "failed"; return failResult(); }
    if (command === "disable") { enabled = false; activity = "inactive"; return okResult(); }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("disabled", 1);
    if (command === "is-active") return activity === "failed" ? failResult("failed", 3) : failResult("inactive", 3);
    return failResult();
  });
  const host = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter });
  expect(() => installServeService(f.vault, host)).toThrow("previous configuration restored");
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(readServeIntent(f.vault)).toBe("opted-out");
});

test("timeout re-query treats a later confirmed active start as success", () => {
  const f = fixture();
  let enabled = false, activity = "inactive", starts = 0;
  const { adapter, now } = systemdAdapter((command) => {
    if (command === "daemon-reload" || command === "enable" || command === "stop") {
      if (command === "enable") enabled = true;
      return okResult();
    }
    if (command === "start") {
      starts++;
      now.value += SYSTEMD_START_TIMEOUT_MS;
      activity = "active";
      enabled = true;
      return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: true };
    }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
    if (command === "is-active") return activity === "active" ? okResult("active") : failResult("inactive", 3);
    return failResult();
  });
  const host = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter });
  const installed = installServeService(f.vault, host);
  expect(starts).toBe(1);
  expect(installed.status).toMatchObject({ state: "active", enabled: true });
  expect(existsSync(journalPath(f.vault))).toBe(false);
  expect(readServeIntent(f.vault)).toBe("installed");
});

test("timeout-bearing inactive and not-found output stays unknown, never stopped or absent", () => {
  const f = fixture();
  const vaultId = ensureVaultId(f.vault);
  for (const [enabled, active] of [
    [
      { ok: false, exitCode: 4, stdout: "not-found", stderr: "", timedOut: true },
      { ok: false, exitCode: 3, stdout: "inactive", stderr: "", timedOut: true },
    ],
    [
      { ok: false, exitCode: 4, stdout: "not-found", stderr: "", timedOut: true },
      { ok: false, exitCode: 3, stdout: "inactive", stderr: "", timedOut: false },
    ],
    [
      { ok: true, exitCode: 0, stdout: "enabled", stderr: "", timedOut: false },
      { ok: false, exitCode: 3, stdout: "inactive", stderr: "", timedOut: true },
    ],
  ] as const) {
    const { adapter } = systemdAdapter((command) => {
      if (command === "is-enabled") return enabled;
      if (command === "is-active") return active;
      return failResult();
    });
    const status = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter }).query(vaultId);
    expect(status.state).toBe("unknown");
    expect(["absent", "disabled", "masked"]).not.toContain(status.state);
    expect(status.detail).toBe("supervisor state could not be queried");
  }
});

test("elapsed-deadline success is timedOut and is not accepted as a successful command", () => {
  const f = fixture();
  const unit = systemdUnitName(ensureVaultId(f.vault));
  const { adapter: reloadAdapter, now: reloadNow } = systemdAdapter((command, timeout) => {
    if (command === "daemon-reload") {
      reloadNow.value += timeout;
      return okResult();
    }
    return failResult();
  });
  expect(realSupervisorHost("systemd", f.root, f.host.execStart, { adapter: reloadAdapter }).reload())
    .toEqual({ ok: false, detail: "service reload failed" });

  let enabled = false, activity = "inactive";
  const { adapter, now } = systemdAdapter((command, timeout) => {
    if (command === "daemon-reload" || command === "enable" || command === "stop") {
      if (command === "enable") enabled = true;
      if (command === "stop") activity = "inactive";
      return okResult();
    }
    if (command === "start") {
      now.value += timeout;
      return okResult();
    }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
    if (command === "is-active") return activity === "active" ? okResult("active") : failResult(activity, 3);
    return failResult();
  });
  expect(realSupervisorHost("systemd", f.root, f.host.execStart, { adapter }).enable("/synthetic/unit", unit))
    .toEqual({ ok: false, detail: "service start timed out" });
});

test("enable re-queries after an ok stop and starts only from stopped or inactiveEnabled", () => {
  const f = fixture();
  const unit = systemdUnitName(ensureVaultId(f.vault));
  for (const activity of ["active", "unknown", "activating", "deactivating"] as const) {
    const calls: string[] = [];
    let enabled = false;
    const { adapter } = systemdAdapter((command) => {
      calls.push(command);
      if (command === "daemon-reload") return okResult();
      if (command === "enable") { enabled = true; return okResult(); }
      if (command === "stop") return okResult();
      if (command === "start") return okResult();
      if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
      if (command === "is-active") {
        if (activity === "active") return okResult("active");
        if (activity === "unknown") return failResult("unknown", 4);
        return failResult(activity, 3);
      }
      return failResult();
    });
    const result = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter }).enable("/synthetic/unit", unit);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(activity === "active" ? "service replacement stop failed" : "service stop timed out");
    expect(calls.includes("stop")).toBe(true);
    expect(calls.includes("start")).toBe(false);
  }

  const calls: string[] = [];
  let enabled = false, activity = "active";
  const { adapter } = systemdAdapter((command) => {
    calls.push(command);
    if (command === "daemon-reload") return okResult();
    if (command === "enable") { enabled = true; return okResult(); }
    if (command === "stop") { activity = "inactive"; return okResult(); }
    if (command === "start") { activity = "active"; return okResult(); }
    if (command === "is-enabled") return enabled ? okResult("enabled") : failResult("not-found", 4);
    if (command === "is-active") return activity === "active" ? okResult("active") : failResult("inactive", 3);
    return failResult();
  });
  const started = realSupervisorHost("systemd", f.root, f.host.execStart, { adapter }).enable("/synthetic/unit", unit);
  expect(started).toEqual({ ok: true, detail: "activated current definition" });
  expect(calls.indexOf("start")).toBeGreaterThan(calls.indexOf("stop"));
});
