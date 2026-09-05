import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { installServeService, uninstallServeService, type SupervisorHost } from "../../src/serve/supervisor";
import { readServeIntent, writeServeIntent } from "../../src/serve/intent";
import type { SupervisorState } from "../../src/serve/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-supervisor-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault); writeServeIntent(vault, "opted-out");
  let state: SupervisorState = "absent";
  let enabled = false;
  const activated: string[] = [];
  const host: SupervisorHost = {
    kind: "systemd", home: root, execStart: ["/synthetic/kizuki-v1", "serve", "--vault", vault],
    query: () => ({ kind: "systemd", state, unit: "synthetic", enabled, detail: state }),
    enable: path => { activated.push(readFileSync(path, "utf8")); state = "active"; enabled = true; return { ok: true, detail: "active" }; },
    disable: () => { state = "disabled"; enabled = false; return { ok: true, detail: "disabled" }; },
  };
  return { root, vault, host, activated, setState: (next: SupervisorState) => { state = next; enabled = next === "active"; } };
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
      enable: () => process.exit(86), disable: () => ({ok:true,detail:"disabled"})
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
