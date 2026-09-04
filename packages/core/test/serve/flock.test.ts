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
    expect(readFileSync(join(directory, ".kizuki", "write-pass.lock"), "utf8")).toBe(
      `${process.pid}\n`,
    );
    lock?.release();
  });
});
