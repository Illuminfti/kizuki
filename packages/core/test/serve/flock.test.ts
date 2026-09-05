import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryWriteFlock } from "../../src/serve/flock";

const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("write-pass flock", () => {
  test("a live holder blocks a second acquire", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-flock-"));
    dirs.push(directory);
    const first = tryWriteFlock(directory);
    expect(first).not.toBeNull();
    expect(tryWriteFlock(directory)).toBeNull();
    first?.release();
    const again = tryWriteFlock(directory);
    expect(again).not.toBeNull();
    again?.release();
  });

  test("a dead holder file is reclaimed", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-flock-"));
    dirs.push(directory);
    mkdirSync(join(directory, ".kizuki"), { recursive: true });
    writeFileSync(join(directory, ".kizuki", "write-pass.lock"), "999999999\n");
    const lock = tryWriteFlock(directory);
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(join(directory, ".kizuki", "write-pass.lock"), "utf8"))).toMatchObject({ schema: "kizuki.writer-diagnostic/v1", pid: process.pid });
    lock?.release();
  });
});

test("the kernel holds exclusion if PID diagnostics disappear, and process death releases it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-native-flock-")); dirs.push(directory);
  const module = new URL("../../src/serve/flock.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `const { tryWriteFlock } = await import(${JSON.stringify(module)}); const lock = tryWriteFlock(${JSON.stringify(directory)}); if (!lock) process.exit(2); console.log("held"); await Bun.stdin.text(); lock.release();`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("held"); reader.releaseLock();
    const { unlinkSync, statSync } = await import("node:fs");
    const nativePath = join(directory, ".kizuki/write-pass.flock");
    unlinkSync(join(directory, ".kizuki/write-pass.lock"));
    expect(tryWriteFlock(directory)).toBeNull();
    const inode = statSync(nativePath).ino;
    child.kill("SIGKILL"); await child.exited;
    const recovered = tryWriteFlock(directory); expect(recovered).not.toBeNull();
    expect(statSync(nativePath).ino).toBe(inode); recovered?.release();
    expect(statSync(nativePath).ino).toBe(inode);
  } finally { child.kill(); await child.exited; }
});

test("legacy live PID diagnostics are protected without an advisory holder", () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-legacy-flock-")); dirs.push(directory);
  mkdirSync(join(directory, ".kizuki"), { recursive: true });
  const path = join(directory, ".kizuki/write-pass.lock");
  writeFileSync(path, `${process.pid}\n`);
  expect(tryWriteFlock(directory)).toBeNull();
  expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
});

test("release does not unlink replacement PID diagnostics", async () => {
  const { unlinkSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "kizuki-replaced-flock-")); dirs.push(directory);
  const lock = tryWriteFlock(directory)!; expect(lock).not.toBeNull();
  unlinkSync(lock.path); writeFileSync(lock.path, "replacement identity\n");
  lock.release(); lock.release();
  expect(readFileSync(lock.path, "utf8")).toBe("replacement identity\n");
});


test("the shared advisory primitive refuses linked ownership inodes", async () => {
  const { tryAdvisoryFileLock } = await import("../../src/util/advisory-file-lock");
  const { symlinkSync, linkSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "kizuki-linked-flock-")); dirs.push(directory);
  const target = join(directory, "target"); writeFileSync(target, "synthetic");
  const symlink = join(directory, "symlink"); symlinkSync(target, symlink);
  expect(() => tryAdvisoryFileLock(symlink)).toThrow();
  const hardlink = join(directory, "hardlink"); linkSync(target, hardlink);
  expect(() => tryAdvisoryFileLock(hardlink)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("synthetic");
});

test("simultaneous processes reclaim one dead legacy holder without overlapping ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-reclaim-flock-")); dirs.push(directory);
  mkdirSync(join(directory, ".kizuki"), { recursive: true });
  writeFileSync(join(directory, ".kizuki/write-pass.lock"), "999999999\n");
  const module = new URL("../../src/serve/flock.ts", import.meta.url).pathname;
  const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "--eval", `const {tryWriteFlock}=await import(${JSON.stringify(module)}); const input=Bun.stdin.stream().getReader(); console.log("ready"); await input.read(); const lock=tryWriteFlock(${JSON.stringify(directory)}); console.log(lock?"entered":"busy"); if(lock) await input.read(); lock?.release();`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  const readers = children.map(child => child.stdout.getReader());
  try {
    for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    await Promise.all(children.map(async child => { child.stdin.write("go\n"); await child.stdin.flush(); }));
    const results = await Promise.all(readers.map(async reader => new TextDecoder().decode((await reader.read()).value).trim()));
    expect(results.filter(result => result === "entered")).toHaveLength(1);
    expect(results.filter(result => result === "busy")).toHaveLength(5);
    for (const child of children) child.stdin.end();
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0, 0, 0]);
  } finally { for (const child of children) child.kill(); await Promise.all(children.map(child => child.exited)); }
}, 15_000);


test("a crash after publishing PID diagnostics but before removing their temporary link remains reclaimable", async () => {
  const { linkSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "kizuki-pid-publish-")); dirs.push(directory);
  mkdirSync(join(directory, ".kizuki"), { recursive: true });
  const temporary = join(directory, ".kizuki/write-pass.lock.synthetic.tmp");
  writeFileSync(temporary, "999999999\n");
  linkSync(temporary, join(directory, ".kizuki/write-pass.lock"));
  const lock = tryWriteFlock(directory); expect(lock).not.toBeNull(); lock?.release();
  expect(readFileSync(temporary, "utf8")).toBe("999999999\n");
});

test("failed diagnostic unlink does not strand native ownership behind a live PID", async () => {
  const { chmodSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "kizuki-unlink-flock-")); dirs.push(directory);
  const lock = tryWriteFlock(directory)!;
  expect(lock).not.toBeNull();
  try {
    chmodSync(join(directory, ".kizuki"), 0o500);
    expect(() => lock.release()).toThrow();
  } finally { chmodSync(join(directory, ".kizuki"), 0o700); }
  const recovered = tryWriteFlock(directory);
  expect(recovered).not.toBeNull(); recovered?.release();
});
