import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "packages/cli/src",
  "packages/mcp/src",
  "packages/tui/src",
  "packages/connectors/src",
  "packages/connector-ics/src",
  "packages/connector-imap/src",
  "packages/connector-telegram/src",
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
  test("production sources do not import openLedger from the public barrel", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join("/workspace", root))) {
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
