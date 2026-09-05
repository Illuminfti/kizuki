import { expect, test } from "bun:test";
import { join } from "node:path";

/** Native fault hooks stay in a child and never change another test's FFI. */
function scenario(mode: string, body: string): void {
  const script = `
    import { mock } from "bun:test";
    import * as ffi from "bun:ffi";
    import * as fs from "node:fs";
    import { join } from "node:path";
    import { strict as assert } from "node:assert";
    const mode = ${JSON.stringify(mode)};
    const root = fs.mkdtempSync("/tmp/kizuki-native-enumeration-");
    const owned = join(root, "owned"), outside = join(root, "outside");
    fs.mkdirSync(owned); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "canary"), "SYNTHETIC_UNOWNED");
    const realDlopen = ffi.dlopen, realCc = ffi.cc;
    const libc = realDlopen("libc.so.6", { __errno_location: { args: [], returns: ffi.FFIType.ptr } });
    const errno = new DataView(ffi.toArrayBuffer(libc.symbols.__errno_location(), 0, 4));
    let injected = 0;
    mock.module("bun:ffi", () => ({ ...ffi, dlopen(...args) {
      const library = realDlopen(...args), original = library.symbols;
      const symbols = { ...original };
      // Also inject at the pre-fix libc seam so these regressions demonstrate
      // the original late-errno failure when run against its implementation.
      if (original.openat) symbols.openat = (...values) => {
        const name = new ffi.CString(values[1]).toString();
        if (mode === "present-with-false-enoent" && name === "present") {
          injected++; errno.setInt32(0, 2, true); return -1;
        }
        const result = original.openat(...values);
        if (mode === "openat-errno" && result < 0) { injected++; errno.setInt32(0, 11, true); }
        return result;
      };
      if (original.readdir) symbols.readdir = (...values) => {
        const result = original.readdir(...values);
        if (mode === "eof-errno" && !result) { injected++; errno.setInt32(0, 11, true); }
        return result;
      };
      if (original.syscall) symbols.syscall = (...values) => {
        assert.equal(values[0], 217n);
        assert.equal(typeof values[1], "bigint");
        assert.equal(typeof values[3], "bigint");
        if (mode === "scan-failed") { injected++; return -1; }
        if (mode === "count-overrun") { injected++; return Number(values[3]) + 1; }
        if (mode.startsWith("malformed-") || mode === "entry-limit") {
          injected++;
          const bytes = Buffer.from(ffi.toArrayBuffer(values[2], 0, Number(values[3]))); bytes.fill(0);
          if (mode === "malformed-header") return 18;
          if (mode === "malformed-length") return 24;
          if (mode === "malformed-overrun") { bytes.writeUInt16LE(32, 16); return 24; }
          if (mode === "malformed-name-size") { bytes.writeUInt16LE(280, 16); bytes.fill(97, 19, 279); return 280; }
          bytes.writeUInt16LE(24, 16); bytes[19] = 97;
          if (mode === "malformed-nul") bytes.fill(97, 19, 24);
          return 24;
        }
        const result = original.syscall(...values);
        if (!injected && mode === "root-rename-during-scan") { injected++; fs.renameSync(owned, join(root, "moved")); fs.mkdirSync(owned); }
        if (mode === "eof-errno" && result === 0) { injected++; errno.setInt32(0, 11, true); }
        return result;
      };
      return { ...library, symbols };
    }, cc(options) {
      const library = realCc(options), original = library.symbols.kizuki_open_owned_child;
      return { ...library, symbols: { ...library.symbols, kizuki_open_owned_child(...values) {
        const name = new ffi.CString(values[1]).toString();
        assert.ok(values[2] === 0 || values[2] === 1);
        if (mode === "present-with-false-enoent" && name === "present") {
          injected++; errno.setInt32(0, 2, true); return -13;
        }
        if (mode === "opaque-present" && new Uint8Array(ffi.toArrayBuffer(values[1], 0, 1))[0] === 255) {
          injected++; errno.setInt32(0, 2, true); return -13;
        }
        if (mode === "fresh-open-failed" && name === ".") { injected++; return -13; }
        if (mode === "fresh-identity" && name === ".") { injected++; return fs.openSync(outside, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); }
        if (mode === "invalid-fd" && name === "missing") { injected++; return 2147483648; }
        const result = original(...values);
        if (mode === "openat-errno" && result < 0) { injected++; errno.setInt32(0, 11, true); }
        if (mode === "create-after-enoent" && name === "missing" && result === -2) {
          injected++; fs.mkdirSync(join(owned, "missing"));
        }
        return result;
      } } };
    } }));
    const { openOwnedDirectory } = await import(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory.ts"))});
    const cap = openOwnedDirectory(owned);
    try {
      ${body}
      if (mode !== "none") assert.ok(injected > 0);
      assert.equal(fs.readFileSync(join(outside, "canary"), "utf8"), "SYNTHETIC_UNOWNED");
      process.stdout.write(JSON.stringify({ passed: true }));
    } finally { cap.close(); libc.close(); fs.rmSync(root, { recursive: true, force: true }); }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ passed: true });
}

test("missing-child absence survives errno changes after the native call", () => {
  scenario("openat-errno", "assert.equal(cap.childIdentity('missing'), null);");
});

test("empty scans survive errno changes after native EOF", () => {
  scenario("eof-errno", "assert.equal(cap.isEmpty(), true); assert.equal(cap.isEmpty(), true);");
});

test("a present child cannot be classified absent by a changed ENOENT value", () => {
  scenario("present-with-false-enoent", "fs.mkdirSync(join(owned, 'present')); assert.throws(() => cap.childIdentity('present'), /unsafe/);");
});

test("failed opens of present symlinks and non-directory files remain unsafe", () => {
  scenario("none", `
    fs.symlinkSync(outside, join(owned, "link"));
    fs.writeFileSync(join(owned, "file"), "synthetic");
    assert.throws(() => cap.childIdentity("link"), /unsafe/);
    assert.throws(() => cap.childIdentity("file"), /unsafe/);
  `);
});

test("native erasure preserves opaque names and refuses permission errors", () => {
  scenario("opaque-present", `
    fs.mkdirSync(join(owned, "store"));
    for (const byte of [255, 254]) fs.writeFileSync(Buffer.concat([Buffer.from(join(owned, "store") + "/"), Buffer.from([byte])]), "synthetic");
    assert.throws(() => cap.removeTree("store", cap.childIdentity("store")), /unsafe/);
  `);
});

test("native erasure visits several directory pages without truncation", () => {
  scenario("none", `
    fs.mkdirSync(join(owned, "store"));
    for (let index = 0; index < 3000; index++) fs.writeFileSync(join(owned, "store", "fixture-" + String(index).padStart(6, "0") + "-".repeat(32)), "synthetic");
    cap.removeTree("store", cap.childIdentity("store"));
    assert.equal(fs.existsSync(join(owned, "store")), false);
  `);
});

for (const mode of ["fresh-open-failed", "fresh-identity", "scan-failed"])
  test(`unreadable or mismatched parent cannot establish emptiness: ${mode}`, () => {
    scenario(mode, "assert.throws(() => cap.isEmpty(), /unsafe|identity_changed/);");
  });

test("root replacement during a scan cannot establish emptiness", () => {
  scenario("root-rename-during-scan", "assert.throws(() => cap.isEmpty(), /identity_changed/);");
});

test("absence is the kernel observation and never a later metadata inference", () => {
  scenario("create-after-enoent", `
    assert.equal(cap.childIdentity("missing"), null);
    assert.ok(fs.existsSync(join(owned, "missing")));
    assert.ok(cap.childIdentity("missing"));
    assert.throws(() => cap.removeTree("missing", null), /identity_changed/);
    assert.ok(fs.existsSync(join(owned, "missing")));
  `);
});

test("invalid native descriptors fail closed", () => {
  scenario("invalid-fd", "assert.throws(() => cap.childIdentity('missing'), /abi_invalid/);");
});

for (const mode of ["count-overrun", "malformed-header", "malformed-length", "malformed-overrun", "malformed-nul", "malformed-name-size"])
  test(`malformed native directory records fail closed: ${mode}`, () => {
    scenario(mode, "assert.throws(() => cap.isEmpty(), /abi_invalid/);");
  });

test("the cumulative entry bound refuses a truncated erasure scan", () => {
  scenario("entry-limit", "fs.mkdirSync(join(owned, 'store')); assert.throws(() => cap.removeTree('store', cap.childIdentity('store')), /bounds/); assert.ok(fs.existsSync(join(owned, 'store')));");
});
