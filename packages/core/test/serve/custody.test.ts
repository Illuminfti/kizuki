import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { custodyNative } from "../../src/util/custody-native";
import { openCanonFiles } from "../../src/vault/canon-files";
import { initVault } from "../../src/vault/init";
import { doctorVault } from "../../src/vault/doctor";
import { serviceAncestorOwner, startServiceCustody } from "../../src/serve/custody";
import { connectServiceCustody } from "../../src/serve/custody-startup";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "custody-inventory-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault);
  return { root, vault };
}

describe("service metadata custody composition", () => {
  test("an invocation string does not activate a capability outside the installed unit", async () => {
    const { vault } = fixture();
    const root = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      let failures = 0;
      await expect(startServiceCustody(vault, "synthetic-vault", { INVOCATION_ID: "1".repeat(32) },
        () => { failures += 1; })).rejects.toThrow("service_custody_unavailable");
      expect(serviceAncestorOwner(vault, root, fstatSync(root, { bigint: true }))).toBeUndefined();
      expect(serviceAncestorOwner(vault + "-other", root, fstatSync(root, { bigint: true }))).toBeUndefined();
      expect(failures).toBe(0);
      const files = openCanonFiles(vault);
      try { files.assertPrivateDirectory(".kizuki"); } finally { files.close(); }
    } finally { closeSync(root); }
  });

  test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "live and orphan invocation sockets are excluded from export/restore and doctor", () => {
      const { root, vault } = fixture(), control = join(vault, ".kizuki");
      const dir = openSync(control, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const names = [`custody-${"1".repeat(32)}.sock`, `custody-${"2".repeat(32)}.sock`];
      const api = custodyNative();
      const live = api.listen(dir, names[0]!);
      const orphan = api.listen(dir, names[1]!); closeSync(orphan);
      const db = openLedger(":memory:");
      try {
        const before = doctorVault(vault);
        const manifest = exportVault(db, vault, join(root, "backup"));
        expect(Object.keys(manifest.files).some(name => name.includes("custody-"))).toBe(false);
        restoreVault(join(root, "backup"), join(root, "restored"));
        expect(readdirSync(join(root, "restored", ".kizuki")).some(name => name.startsWith("custody-"))).toBe(false);
        expect(doctorVault(vault)).toEqual(before);
        const files = openCanonFiles(vault);
        try { files.assertPrivateDirectory(".kizuki"); } finally { files.close(); }
        for (const name of names) expect(existsSync(join(control, name))).toBe(true);
      } finally { db.close(); closeSync(live); closeSync(dir); }
    });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("service socket readiness", () => {
  function boundSocket() {
    const directory = mkdtempSync(join(tmpdir(), "custody-bound-")); roots.push(directory);
    const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const libc = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      bind: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const socket = libc.symbols.socket(1, 5 | 0x80000, 0);
    if (socket < 0) throw new Error("synthetic socket unavailable");
    const name = "broker.sock", path = join(directory, name);
    const address = Buffer.alloc(110); address.writeUInt16LE(1); address.write(path, 2);
    const mask = process.umask(0o177);
    try { expect(libc.symbols.bind(socket, ptr(address), Buffer.byteLength(path) + 3)).toBe(0); }
    finally { process.umask(mask); }
    return { control, socket, path, name,
      listen() { expect(libc.symbols.listen(socket, 1)).toBe(0); },
      close() { closeSync(socket); closeSync(control); libc.close(); },
    };
  }

  test("waits for the exact 0600 bound socket to start listening", async () => {
    const f = boundSocket(); let socket = -1;
    const timer = setTimeout(() => f.listen(), 75);
    try {
      expect(() => custodyNative().connect(f.control, f.name)).toThrow("custody_native_unavailable");
      let checks = 0;
      const result = await connectServiceCustody(f.control, f.name, () => { checks += 1; }, 1000);
      socket = result.socket;
      expect(checks).toBeGreaterThan(1);
      expect(custodyNative().peer(socket).pid).toBe(process.pid);
    } finally { clearTimeout(timer); if (socket >= 0) closeSync(socket); f.close(); }
  });

  for (const mutation of ["mode", "replacement", "authority"] as const) test(`refuses ${mutation} changes during readiness`, async () => {
    const f = boundSocket(); let replacement = -1, valid = true, mutated = false;
    const timer = setTimeout(() => {
      mutated = true;
      if (mutation === "mode") chmodSync(f.path, 0o666);
      else if (mutation === "replacement") { unlinkSync(f.path); replacement = custodyNative().listen(f.control, f.name); }
      else valid = false;
    }, 50);
    try {
      await expect(connectServiceCustody(f.control, f.name, () => {
        if (!valid) throw new Error("synthetic authority lost");
      }, 1000)).rejects.toThrow();
      expect(mutated).toBe(true);
    } finally { clearTimeout(timer); if (replacement >= 0) closeSync(replacement); f.close(); }
  });

  test("a stable endpoint that never listens has a bounded deadline", async () => {
    const f = boundSocket(), start = performance.now();
    try {
      await expect(connectServiceCustody(f.control, f.name, () => {}, 100)).rejects.toThrow();
      expect(performance.now() - start).toBeGreaterThanOrEqual(90);
      expect(performance.now() - start).toBeLessThan(1000);
    } finally { f.close(); }
  });
});
