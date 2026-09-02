import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "../src");

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      out.push(...walk(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("retrieval-pg isolation", () => {
  test("sources do not import the ledger, fetch, or spawn a process", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /(?:from\s+|import\s*\()\s*["']bun:sqlite["']/,
      );
      expect(source).not.toMatch(/["'`]kizuki\.db["'`]/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/node:child_process|node:http|node:net/);
      expect(source).not.toMatch(/Bun\.spawn|spawnSync/);
    }
  });
});
