import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

/**
 * The repository's denylist scan runs `git grep -I`, and `-I` skips every file
 * git classifies as binary. One NUL byte in a source file therefore takes that
 * file out of the gate — and out of every reviewable diff — while the build
 * stays green. Assert the property the gate silently depends on: the workspace
 * TypeScript is text.
 */

const PACKAGES = join(import.meta.dir, "..", "..");

/** Tab, newline and carriage return are layout; every other C0 byte hides. */
const RAW_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function typescriptFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...typescriptFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => [
    ...typescriptFiles(join(PACKAGES, entry.name, "src")),
    ...typescriptFiles(join(PACKAGES, entry.name, "test")),
  ])
  .sort();

describe("workspace TypeScript stays scannable text", () => {
  test("the workspace is actually being scanned", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("no TypeScript file carries a NUL byte", () => {
    const binary = files.filter((file) => readFileSync(file).includes(0));
    expect(binary.map((file) => relative(PACKAGES, file))).toEqual([]);
  });

  test("no TypeScript file carries a raw control character", () => {
    const carriers = files.filter((file) =>
      RAW_CONTROL.test(readFileSync(file, "utf8")),
    );
    expect(carriers.map((file) => relative(PACKAGES, file))).toEqual([]);
  });
});
