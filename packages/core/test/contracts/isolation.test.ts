import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const CONTRACT_FILES = [
  "ports.ts",
  "registry.ts",
  "retrieval.ts",
  "embedding.ts",
  "llm.ts",
  "producer.ts",
  "connector.ts",
  "notifier.ts",
  "storage.ts",
  "surface.ts",
  "remote.ts",
] as const;

describe("port source isolation", () => {
  test("every RFC 0002 port contract exists", () => {
    for (const file of CONTRACT_FILES) {
      expect(
        existsSync(join(import.meta.dir, "../../src/contracts", file)),
      ).toBe(true);
    }
  });

  test("port sources do not import the ledger database or name its path", () => {
    for (const file of CONTRACT_FILES) {
      const path = join(import.meta.dir, "../../src/contracts", file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /(?:from\s+|import\s*\()\s*["']bun:sqlite["']/,
      );
      expect(source).not.toMatch(/["'`]kizuki\.db["'`]/);
    }
  });
});
