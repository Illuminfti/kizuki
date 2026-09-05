import { expect, test } from "bun:test";
import { join } from "node:path";

for (const mode of ["memfd", "write", "add-seals", "read-seals", "compile", "success"])
  test(`fixed native helper closes its source and fails closed: ${mode}`, () => {
    const script = `
      import { mock } from "bun:test";
      import * as ffi from "bun:ffi";
      import * as fs from "node:fs";
      import { strict as assert } from "node:assert";
      const mode = ${JSON.stringify(mode)};
      const realDlopen = ffi.dlopen, realCc = ffi.cc, realWrite = fs.writeFileSync;
      let sourceFd = -1, closes = 0, compiled = false;
      mock.module("node:fs", () => ({ ...fs, writeFileSync(...args) {
        if (mode === "write" && args[0] === sourceFd) {
          realWrite(sourceFd, "partial source"); throw new Error("synthetic private detail");
        }
        return realWrite(...args);
      } }));
      mock.module("bun:ffi", () => ({ ...ffi, dlopen(...args) {
        const library = realDlopen(...args), original = library.symbols;
        return { ...library, close() { closes++; library.close(); }, symbols: {
          ...original,
          memfd_create(...values) {
            assert.equal(values[1], 3);
            if (mode === "memfd") return -1;
            return sourceFd = original.memfd_create(...values);
          },
          fcntl(...values) {
            if (mode === "add-seals" && values[1] === 1033) return -1;
            if (mode === "read-seals" && values[1] === 1034) return 7;
            return original.fcntl(...values);
          },
        } };
      }, cc(options) {
        compiled = true;
        assert.equal(options.source, '/proc/self/fd/' + sourceFd);
        assert.deepEqual(options.flags, ['-nostdlib', '-x', 'c']);
        assert.throws(() => fs.writeSync(sourceFd, 'changed'), { code: 'EPERM' });
        if (mode === "compile") throw new Error("synthetic private detail");
        return realCc(options);
      } }));
      const { loadOwnedDirectoryNative } = await import(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))});
      if (mode === 'success') {
        const api = loadOwnedDirectoryNative();
        assert.equal(closes, 0); assert.ok(compiled);
        const name = Buffer.from('synthetic-missing\\0');
        assert.equal(api.symbols.openChild(-1, ffi.ptr(name), 0), -9);
        api.compiled.close(); api.libc.close();
      } else {
        assert.throws(() => loadOwnedDirectoryNative(), { message: 'owned_directory_native_unavailable' });
        assert.equal(closes, 1);
        assert.equal(compiled, mode === 'compile');
      }
      if (sourceFd >= 0) assert.throws(() => fs.fstatSync(sourceFd), { code: 'EBADF' });
      process.stdout.write('passed');
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("passed");
  });
