import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

/**
 * The repository's denylist scan runs `git grep -I`, and `-I` skips every file
 * git classifies as binary. One NUL byte in a source file therefore takes that
 * file out of the gate — and out of every reviewable diff — while the build
 * stays green. Assert the property the gate silently depends on over the
 * files these importers own: a workspace-wide scan lives in the workspace
 * gate, not in one connector's tests, where another lane's edit would fail
 * under this file's name.
 */

const CONNECTORS = join(import.meta.dir, "..");

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

const OWNED = [
  join(CONNECTORS, "src", "legacy"),
  join(CONNECTORS, "src", "import-legacy-wiki"),
  join(CONNECTORS, "src", "import-legacy-events"),
];

const files = [
  ...OWNED.flatMap((directory) => typescriptFiles(directory)),
  ...typescriptFiles(join(CONNECTORS, "test")).filter((file) =>
    /(?:legacy|source-text)/.test(file),
  ),
].sort();

describe("the migration importers stay scannable text", () => {
  test("the importers are actually being scanned", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("no TypeScript file carries a NUL byte", () => {
    const binary = files.filter((file) => readFileSync(file).includes(0));
    expect(binary.map((file) => relative(CONNECTORS, file))).toEqual([]);
  });

  test("no TypeScript file carries a raw control character", () => {
    const carriers = files.filter((file) =>
      RAW_CONTROL.test(readFileSync(file, "utf8")),
    );
    expect(carriers.map((file) => relative(CONNECTORS, file))).toEqual([]);
  });
});
