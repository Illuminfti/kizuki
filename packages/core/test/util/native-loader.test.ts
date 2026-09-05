import { expect, test } from "bun:test";
import { join } from "node:path";

const OUTPUT_LIMIT = 64 * 1024;

type DrainedOutput = { text: string; overflowed: boolean };
type ChildResult =
  | { kind: "exited"; exitCode: number; stdout: DrainedOutput; stderr: DrainedOutput }
  | { kind: "child_timeout"; exitCode: number; stdoutDrained: true; stderrDrained: true };

async function drainBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<DrainedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let overflowed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (retained >= limit) {
        overflowed = true;
        continue;
      }
      const prefix = value.subarray(0, limit - retained);
      chunks.push(prefix);
      retained += prefix.length;
      if (prefix.length !== value.length) overflowed = true;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), overflowed };
}

async function runChild(script: string, deadlineMs = 15_000): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = drainBounded(child.stdout, OUTPUT_LIMIT);
  const stderr = drainBounded(child.stderr, OUTPUT_LIMIT);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, deadlineMs);

  try {
    const [exitCode, drainedStdout, drainedStderr] = await Promise.all([child.exited, stdout, stderr]);
    if (timedOut) {
      return { kind: "child_timeout", exitCode, stdoutDrained: true, stderrDrained: true };
    }
    return { kind: "exited", exitCode, stdout: drainedStdout, stderr: drainedStderr };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.allSettled([stdout, stderr]);
  }
}

for (const mode of ["memfd", "write", "add-seals", "read-seals", "compile", "success"])
  test(`fixed native helper closes its source and fails closed: ${mode}`, async () => {
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
    const result = await runChild(script);
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") throw new Error(`native_loader_child_${result.kind}:${mode}`);
    if (result.stdout.overflowed || result.stderr.overflowed)
      throw new Error(`native_loader_child_output_overflow:${mode}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe("passed");
    expect(result.stderr.text).toBe("");
  });

test("native child harness kills, reaps, and drains a deadline-overrun child", async () => {
  const result = await runChild("await new Promise(() => {});", 25);
  expect(result.kind).toBe("child_timeout");
  if (result.kind !== "child_timeout") throw new Error("native_loader_child_deadline_missing");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdoutDrained).toBe(true);
  expect(result.stderrDrained).toBe(true);
});
