import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOwnedDirectoryNative } from "../../src/util/owned-directory-native";

const supported = (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64");
const moduleUrl = JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"));

function child(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test.skipIf(!supported)("the owned-directory loader returns one process-wide instance", () => {
  expect(loadOwnedDirectoryNative()).toBe(loadOwnedDirectoryNative());
});

test.skipIf(!supported)("a thousand loader calls compile the sealed source once", () => {
  const result = child(`
    import { mock } from "bun:test";
    import * as ffi from "bun:ffi";
    const realCc = ffi.cc;
    let compiles = 0;
    mock.module("bun:ffi", () => ({ ...ffi, cc(options) { compiles++; return realCc(options); } }));
    const { loadOwnedDirectoryNative } = await import(${moduleUrl});
    const first = loadOwnedDirectoryNative();
    for (let index = 0; index < 1000; index++) if (loadOwnedDirectoryNative() !== first) throw new Error("distinct instance");
    process.stdout.write(String(compiles));
  `);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(result.stdout).toBe("1");
}, 90_000);

test.skipIf(!supported)("a failed compile is not cached and a later call can still succeed", () => {
  const result = child(`
    import { mock } from "bun:test";
    import * as ffi from "bun:ffi";
    const realCc = ffi.cc;
    let attempts = 0;
    mock.module("bun:ffi", () => ({ ...ffi, cc(options) {
      attempts++;
      if (attempts === 1) throw new Error("synthetic compile refusal");
      return realCc(options);
    } }));
    const { loadOwnedDirectoryNative } = await import(${moduleUrl});
    let refused = false;
    try { loadOwnedDirectoryNative(); } catch (error) { refused = error.message === "owned_directory_native_unavailable"; }
    const api = loadOwnedDirectoryNative();
    process.stdout.write(JSON.stringify({ refused, attempts, same: api === loadOwnedDirectoryNative() }));
  `);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ refused: true, attempts: 2, same: true });
}, 90_000);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")("repeated loader calls keep resident memory flat", () => {
  // The uncached loader leaked about 0.34 MB of native image per call, so 300
  // calls grew RSS by roughly 100 MB before this cache existed.
  const result = child(`
    import { readFileSync } from "node:fs";
    const { loadOwnedDirectoryNative } = await import(${moduleUrl});
    const rss = () => Number(/VmRSS:\\s+(\\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"))[1]) * 1024;
    loadOwnedDirectoryNative(); Bun.gc(true);
    const before = rss();
    for (let index = 0; index < 300; index++) loadOwnedDirectoryNative();
    Bun.gc(true);
    process.stdout.write(String(rss() - before));
  `);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(Number(result.stdout)).toBeLessThan(10 * 1024 * 1024);
}, 90_000);

test("no source module compiles owned-directory natives outside the cached loader", () => {
  const root = join(import.meta.dir, "../../src");
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".ts") || path.endsWith("owned-directory-native.ts")) continue;
      if (/\b(?:loadLinuxOwnedDirectoryNative|loadDarwinOwnedDirectoryNative|compileOwnedDirectoryNative)\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
  const loader = readFileSync(join(root, "util/owned-directory-native.ts"), "utf8");
  expect(loader).toMatch(/export function loadOwnedDirectoryNative\(\)[^{]*\{\s*return cached \?\?= compileOwnedDirectoryNative\(\);\s*\}/);
  expect(loader).not.toMatch(/export function (?:loadLinux|loadDarwin|compile)OwnedDirectoryNative/);
});

test.skipIf(!supported)("the shared native exposes frozen symbols and no close that could break other callers", () => {
  const api = loadOwnedDirectoryNative() as unknown as Record<string, unknown> & { symbols: Record<string, unknown> };
  expect(Object.keys(api)).toEqual(["symbols"]);
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.isFrozen(api.symbols)).toBe(true);
  expect("close" in api || "libc" in api || "compiled" in api).toBe(false);
  expect(() => { api["symbols"] = {}; }).toThrow(TypeError);
  expect(() => { api.symbols["openChild"] = () => 0; }).toThrow(TypeError);
  expect(loadOwnedDirectoryNative()).toBe(api as unknown as ReturnType<typeof loadOwnedDirectoryNative>);
});
