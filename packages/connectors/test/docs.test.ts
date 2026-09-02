import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_EVENTS_FIXTURE } from "../src/import-legacy-events/fixture";
import { parseLegacyEventsMapping } from "../src/import-legacy-events/mapping";
import { LEGACY_WIKI_FIXTURE } from "../src/import-legacy-wiki/fixture";
import { parseLegacyWikiMapping } from "../src/import-legacy-wiki/mapping";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DOC = readFileSync(join(ROOT, "docs", "legacy-import.md"), "utf8");

interface Block {
  heading: string;
  body: string;
}

/** Every fenced JSON block, tagged with the nearest heading above it. */
function jsonBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let heading = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("#")) {
      heading = line.replace(/^#+\s*/, "").toLowerCase();
      continue;
    }
    if (line.trim() !== "```json") continue;
    const close = lines.indexOf("```", index + 1);
    expect(close).toBeGreaterThan(index);
    blocks.push({ heading, body: lines.slice(index + 1, close).join("\n") });
    index = close;
  }
  return blocks;
}

describe("docs/legacy-import.md", () => {
  test("every JSON example parses through the parser its heading names", () => {
    const blocks = jsonBlocks(DOC);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const raw: unknown = JSON.parse(block.body);
      if (block.heading.includes("wiki mapping")) {
        expect(parseLegacyWikiMapping(raw)).toBeDefined();
        continue;
      }
      if (block.heading.includes("events mapping (sqlite)")) {
        expect(parseLegacyEventsMapping(raw, "sqlite")).toBeDefined();
        continue;
      }
      if (block.heading.includes("events mapping (jsonl)")) {
        expect(parseLegacyEventsMapping(raw, "jsonl")).toBeDefined();
        continue;
      }
      throw new Error(
        `a JSON example under "${block.heading}" names no parser; give its heading one`,
      );
    }
  });

  test("both fixture mappings appear verbatim, so the examples cannot rot", () => {
    expect(DOC).toContain(JSON.stringify(LEGACY_WIKI_FIXTURE.mapping, null, 2));
    expect(DOC).toContain(
      JSON.stringify(LEGACY_EVENTS_FIXTURE.mapping, null, 2),
    );
  });

  test("the doc claims no command the CLI on this revision does not have", () => {
    const verbs = readFileSync(
      join(ROOT, "packages", "cli", "src", "main.ts"),
      "utf8",
    );
    for (const command of [...DOC.matchAll(/^kizuki ([a-z-]+)/gm)]) {
      expect(verbs).toContain(`verb === "${command[1] as string}"`);
    }
  });

  test("the README points at the doc without claiming more than it does", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("docs/legacy-import.md");
    expect(readme).not.toContain("live sync");
  });
});
