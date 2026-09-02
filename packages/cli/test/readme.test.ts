import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  extractFences,
  extractHeadings,
  extractTables,
  sections,
} from "../../../scripts/markdown";
import { COMMANDS } from "../src/commands/index";

const README = readFileSync(join(import.meta.dir, "../../../README.md"), "utf8");

function verbTableRows(): string[] {
  const runs = sections(README).find(
    (section) => section.heading.text === "What runs today",
  );
  if (runs === undefined) {
    throw new Error("README has no What runs today section");
  }
  const table = extractTables(runs.text).find(
    (candidate) => candidate.header[0] === "Verb",
  );
  if (table === undefined) throw new Error("README has no Verb table");
  return table.rows.map((row) => (row.cells[0] ?? "").replace(/`/g, ""));
}

function quickstart(): string {
  const heading = extractHeadings(README).find(
    (candidate) => candidate.text === "Try it (pre-alpha)",
  );
  if (heading === undefined) throw new Error("README has no Try it section");
  const fence = extractFences(README).find(
    (candidate) => candidate.line > heading.line,
  );
  if (fence === undefined) {
    throw new Error("Try it section has no fenced block");
  }
  return fence.body;
}

describe("README and the CLI agree", () => {
  test("the README verb table is exactly COMMANDS, in order", () => {
    expect(verbTableRows()).toEqual(COMMANDS.map((command) => command.name));
  });

  test("the stranger loop names every verb the quickstart drives", () => {
    const block = quickstart();
    for (const verb of [
      "init",
      "import",
      "review --list",
      "promote",
      "query",
      "doctor",
      "export --out",
    ]) {
      expect(block).toContain(`kizuki ${verb}`);
    }
  });

  test("the quickstart runs the CLI from the tree, never an installed binary", () => {
    expect(README).toContain("`kizuki` stands for `bun packages/cli/src/main.ts`");
    expect(quickstart()).not.toContain("npm install");
    expect(quickstart()).not.toContain("brew install");
  });
});
