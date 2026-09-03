import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SERVE_DIR = join(import.meta.dir, "../../src/serve");

describe("serve-daemon invariants", () => {
  test("the daemon never opens a canon page itself", () => {
    const files = readdirSync(SERVE_DIR).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(SERVE_DIR, file), "utf8");
      expect(source).not.toContain("applyCanonWrite");
      expect(source).not.toContain("writePage");
      expect(source).not.toContain("vault/write");
      expect(source).not.toMatch(/\breview\b.*promot/);
      expect(source).not.toContain("owner-invoked");
    }
  });
});
