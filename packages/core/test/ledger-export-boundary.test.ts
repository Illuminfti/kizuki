import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const ROOTS = [
  "packages/cli/src",
  "packages/mcp/src",
  "packages/tui/src",
  "packages/connectors/src",
  "packages/connector-beeper/src",
  "packages/connector-gmail/src",
  "packages/connector-google-calendar/src",
  "packages/connector-ics/src",
  "packages/connector-imap/src",
  "packages/connector-screenpipe/src",
  "packages/connector-telegram/src",
  "packages/connector-whoop/src",
  "packages/connector-x/src",
  "packages/llm/src",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("ledger export boundary", () => {
  test("checkpoint writes remain in ingest, backup restore and schema migration", () => {
    const writers: string[] = [];
    const retiredCalls: string[] = [];
    for (const pkg of readdirSync(join(REPO, "packages")).sort()) {
      const root = join(REPO, "packages", pkg, "src");
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        const text = readFileSync(file, "utf8");
        if (/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`\[]?(?:checkpoints|connection_runs)\b/i.test(text)) {
          writers.push(relative(REPO, file).replaceAll("\\", "/"));
        }
        if (/\b(?:saveCheckpoint|recordConnectorRun|writeCheckpoint)\s*\(/.test(text)) {
          retiredCalls.push(relative(REPO, file));
        }
      }
    }
    expect(writers.sort()).toEqual([
      "packages/core/src/export.ts",
      "packages/core/src/ingest/run.ts",
      "packages/core/src/ledger/schema-v16.ts",
    ]);
    expect(retiredCalls).toEqual([]);
  });

  test("production sources do not import openLedger from the public barrel", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        const text = readFileSync(file, "utf8");
        const statements = text.split(/import\s+/);
        for (const statement of statements) {
          if (!statement.includes("openLedger")) continue;
          const from = /from\s+["'](@kizuki\/core(?:\/[^"']+)?)["']/.exec(statement);
          if (from?.[1] === "@kizuki/core") hits.push(file);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
