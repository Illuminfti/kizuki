import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "../src");

describe("embed-local-http isolation", () => {
  test("sources reach the network only through the one loopback socket", () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(join(SRC, name), "utf8");
      expect(source).not.toMatch(/(?:from\s+|import\s*\()\s*["']bun:sqlite["']/);
      expect(source).not.toMatch(/["'`]kizuki\.db["'`]/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/node:child_process|node:http|node:https|node:net|node:dns|node:tls/);
      expect(source).not.toMatch(/Bun\.spawn|spawnSync|Bun\.serve|Bun\.listen|WebSocket/);
      if (name !== "http.ts") expect(source).not.toMatch(/Bun\.connect/);
    }
  });
});
