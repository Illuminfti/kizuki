import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { installServeService, uninstallServeService, type SupervisorHost } from "../../src/serve/supervisor";
import { readServeIntent, writeServeIntent } from "../../src/serve/intent";
import type { SupervisorKind, SupervisorState, SupervisorStatus } from "../../src/serve/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
});

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
  const original = readFileSync(first.unitPath!, "utf8");
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
  writeFileSync(journalPath(f.vault), JSON.stringify({ ...valid, extra: true }));
  const snapshot = readFileSync(journalPath(f.vault), "utf8");
  let mutations = 0;
  const host: SupervisorHost = { ...f.host,
    enable: (path, name) => { mutations++; return f.host.enable(path, name); },
    disable: name => { mutations++; return f.host.disable(name); },
  };
  expect(() => installServeService(f.vault, host)).toThrow("another vault or service location");
  expect(mutations).toBe(0);
  expect(readFileSync(journalPath(f.vault), "utf8")).toBe(snapshot);
  expect(readFileSync(first.unitPath!, "utf8")).not.toBe(original);
});
