import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { readRailCursor } from "../../src/ledger/checkpoints";
import { advanceExtractCheckpoint } from "../../src/serve/extract-checkpoint";

const sourceRoot = join(import.meta.dir, "../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importers(fragment: string): string[] {
  return sourceFiles(sourceRoot)
    .filter(path => readFileSync(path, "utf8").includes(fragment))
    .map(path => relative(sourceRoot, path));
}

test("extract checkpoint advancement is transaction-owned and validates its cursor", () => {
  const db = openLedger(":memory:");
  try {
    expect(() => advanceExtractCheckpoint(db, "extract", "frontier")).toThrow(
      "extraction checkpoint advancement requires a transaction",
    );
    expect(readRailCursor(db, "kizuki.producer.model", "extract")).toBeNull();
    expect(() => db.transaction(() => advanceExtractCheckpoint(db, "other" as "extract", "frontier")).immediate()).toThrow(
      "invalid extraction checkpoint key",
    );
    expect(() => db.transaction(() => advanceExtractCheckpoint(db, "extract", "")).immediate()).toThrow(
      "extraction checkpoint cursor must be non-empty",
    );
    db.transaction(() => advanceExtractCheckpoint(db, "extract", "frontier")).immediate();
    expect(readRailCursor(db, "kizuki.producer.model", "extract")).toBe("frontier");
  } finally {
    db.close();
  }
});

test("extract rails have one writer and no checkpoint alias", () => {
  expect(importers('from "./extract-checkpoint"')).toEqual(["serve/extract.ts"]);
  expect(importers("writeResumeCursor")).toEqual([]);
  expect(importers("writeCheckpoint")).toEqual([]);
  expect(readFileSync(join(sourceRoot, "index.ts"), "utf8")).not.toContain("writeCheckpoint");
  expect(readFileSync(join(sourceRoot, "index.ts"), "utf8")).not.toContain("writeResumeCursor");
});
