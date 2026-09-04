import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("package boundaries", () => {
  test("CLI source does not import TUI by relative path", () => {
    const root = join(import.meta.dir, "../src");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      if (text.includes("../tui/") || text.includes("../../tui/")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
