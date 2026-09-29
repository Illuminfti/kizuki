import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { writeServeIntent } from "../../src/serve/intent";
import { requestServeStop } from "../../src/serve/stop-control";
import {
  installServeService, queryServeService, serviceBoundElsewhere, uninstallServeService, type SupervisorHost,
} from "../../src/serve/supervisor";
import { systemdUnitPath } from "../../src/serve/units";
import { ensureVaultId } from "../../src/serve/vault-id";
import type { SupervisorKind, SupervisorState } from "../../src/serve/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function world(kind: SupervisorKind = "systemd", vaultArgs = true) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-binding-")); roots.push(root);
  const original = join(root, "original");
  initVault(original); writeServeIntent(original, "opted-out");
  let state: SupervisorState = "absent";
  let enabled = false;
  const calls: string[] = [];
  const host: SupervisorHost = {
    kind, home: root,
    execStart: vaultArgs ? ["/synthetic/kizuki", "serve", "--vault", original] : ["/synthetic/kizuki", "serve"],
    query: id => { calls.push(`query:${id}`); return { kind, state, unit: "synthetic", enabled, detail: state }; },
    reload: () => ({ ok: true, detail: "reloaded" }),
    enable: () => { calls.push("enable"); state = "active"; enabled = true; return { ok: true, detail: "active" }; },
    disable: () => { calls.push("disable"); state = "disabled"; enabled = false; return { ok: true, detail: "disabled" }; },
    ...(kind === "systemd" ? { enableWithoutStart: () => { enabled = true; return { ok: true, detail: "enabled" }; } } : {}),
  };
  const copy = () => {
    const path = join(root, `copy-${roots.length}-${calls.length}`);
    cpSync(original, path, { recursive: true });
    for (const dir of [path, join(path, ".kizuki")]) chmodSync(dir, 0o700);
    writeServeIntent(path, "installed");
    return path;
  };
  return { root, original, host, calls, copy };
}

for (const kind of ["systemd", "launchd"] as const) {
  test(`${kind}: a vault copy with the same id never reports or controls the original's service`, () => {
    const w = world(kind);
    installServeService(w.original, w.host);
    const copy = w.copy();
    expect(ensureVaultId(copy)).toBe(ensureVaultId(w.original));
    const definition = () => readFileSync(join(w.root, kind === "systemd"
      ? `.config/systemd/user/kizuki@${ensureVaultId(w.original)}.service`
      : `Library/LaunchAgents/dev.kizuki.${ensureVaultId(w.original)}.plist`), "utf8");
    const before = definition();
    const callsBefore = w.calls.length;

    const status = queryServeService(copy, w.host);
    expect(status.state).toBe("absent");
    expect(status.unit).toBeNull();
    expect(status.enabled).toBe(false);
    expect(status.detail).toContain(w.original);
    expect(status.detail).toContain(`kizuki serve --vault ${copy}`);

    expect(() => installServeService(copy, w.host)).toThrow(/serves another vault/);
    expect(() => uninstallServeService(copy, w.host)).toThrow(/serves another vault/);
    expect(w.calls.length).toBe(callsBefore);
    expect(definition()).toBe(before);

    // The owning vault still sees and controls its own service.
    expect(queryServeService(w.original, w.host).state).toBe("active");
    expect(uninstallServeService(w.original, w.host).removed).toBe(true);
  });
}

test("the owning vault is recognised through a symlinked path", () => {
  const w = world();
  installServeService(w.original, w.host);
  const alias = join(w.root, "alias");
  symlinkSync(w.original, alias);
  expect(serviceBoundElsewhere(alias, w.host)).toBeNull();
  expect(queryServeService(alias, w.host).state).toBe("active");
});

test("a definition bound to a vault that no longer exists may be replaced by the moved vault", () => {
  const w = world();
  installServeService(w.original, w.host);
  const moved = w.copy();
  rmSync(w.original, { recursive: true, force: true });
  expect(serviceBoundElsewhere(moved, w.host)).toBeNull();
  const result = installServeService(moved, { ...w.host, execStart: ["/synthetic/kizuki", "serve", "--vault", moved] });
  expect(result.wrote).toBe(true);
  expect(readFileSync(result.unitPath!, "utf8")).toContain(moved);
});

test("a definition that names no vault is not attributed to another vault", () => {
  const w = world("systemd", false);
  installServeService(w.original, w.host);
  expect(existsSync(systemdUnitPath(w.root, ensureVaultId(w.original)))).toBe(true);
  expect(serviceBoundElsewhere(w.copy(), w.host)).toBeNull();
});

test("supervisor none has no unit to confuse", () => {
  const w = world("none");
  expect(serviceBoundElsewhere(w.copy(), w.host)).toBeNull();
});

test("serve stop on a copy queues its request inside the copy only and never calls the supervisor", async () => {
  const w = world();
  installServeService(w.original, w.host);
  const marker = JSON.stringify({ pid: process.pid, boot_id: "synthetic-boot", instance_id: "3f2b7c1e-9d4a-4c5b-8e6f-1a2b3c4d5e6f" }) + "\n";
  writeFileSync(join(w.original, ".kizuki", "serve.pid"), marker, { mode: 0o600 });
  const copy = w.copy();
  const callsBefore = w.calls.length;
  expect((await requestServeStop(copy)).status).toBe("queued");
  expect(existsSync(join(copy, ".kizuki", "serve-stop.json"))).toBe(true);
  expect(existsSync(join(w.original, ".kizuki", "serve-stop.json"))).toBe(false);
  expect(w.calls.length).toBe(callsBefore);
});
