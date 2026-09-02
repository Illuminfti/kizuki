import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractHeadings, extractTables } from "../../../scripts/markdown";
import type { Table } from "../../../scripts/markdown";
import { REGISTRY, getConnector } from "../src/registry";

// Synthetic paths only. Every connector constructor validates its config
// without touching disk, so manifest() is readable without fixtures.
const FIXTURE_CONFIGS: Record<string, unknown> = {
  "kizuki.markdown-folder": { path: "/acme/notes" },
  "kizuki.import-chatgpt": { path: "/acme/chatgpt-export.json" },
  "kizuki.import-claude": { path: "/acme/claude-export.json" },
  "kizuki.screenpipe": { path: "/acme/screenpipe.db" },
};

const HONEST_MODES = [
  "folder snapshot",
  "export import",
  "live sync",
  "local loopback",
];

const DOC = readFileSync(
  join(import.meta.dir, "../../../docs/connectors.md"),
  "utf8",
);
const ids = Object.keys(REGISTRY).sort();

function tableWithHeader(first: string): Table {
  const table = extractTables(DOC).find(
    (candidate) => candidate.header[0] === first,
  );
  if (table === undefined)
    throw new Error(`docs/connectors.md has no ${first} table`);
  return table;
}

const shipped = tableWithHeader("connector_id");
const planned = extractTables(DOC).filter(
  (table) => table.header[0] === "connector_id",
)[1];

function cell(row: { cells: string[] }, column: string): string {
  const index = shipped.header.indexOf(column);
  return row.cells[index] ?? "";
}

function flag(value: boolean): string {
  return value ? "yes" : "no";
}

describe("docs/connectors.md", () => {
  test("every registry connector has a fixture config for the docs test", () => {
    for (const id of ids) {
      if (FIXTURE_CONFIGS[id] === undefined) {
        throw new Error(
          `${id} has no fixture config in packages/connectors/test/docs.test.ts`,
        );
      }
    }
  });

  test("the Shipped table lists exactly the registry, sorted", () => {
    expect(shipped.rows.map((row) => cell(row, "connector_id"))).toEqual(ids);
  });

  test("every Shipped row matches its manifest", () => {
    for (const row of shipped.rows) {
      const id = cell(row, "connector_id");
      const manifest = getConnector(id, FIXTURE_CONFIGS[id]).manifest();
      expect({
        id,
        auth: cell(row, "auth"),
        kinds: cell(row, "kinds"),
      }).toEqual({
        id,
        auth: manifest.auth_modes.join(", "),
        kinds: manifest.kinds.join(", "),
      });
      expect({
        id,
        backfill: cell(row, "backfill"),
        sync: cell(row, "sync"),
        tombstones: cell(row, "tombstones"),
        purge: cell(row, "purge"),
        fixture: cell(row, "fixture"),
        hint: cell(row, "hint"),
      }).toEqual({
        id,
        backfill: flag(manifest.capabilities.backfill),
        sync: flag(manifest.capabilities.sync),
        tombstones: flag(manifest.capabilities.tombstones),
        purge: flag(manifest.capabilities.purge),
        fixture: flag(manifest.capabilities.fixture),
        hint: flag(manifest.emits_sensitivity_hint),
      });
    }
  });

  test("the mode cell is one of the four honest words", () => {
    for (const row of shipped.rows) {
      expect(HONEST_MODES).toContain(cell(row, "mode"));
    }
  });

  test("every registry connector has its own H3 section", () => {
    const sections = extractHeadings(DOC)
      .filter((heading) => heading.level === 3)
      .map((heading) => heading.text);
    for (const id of ids) expect(sections).toContain(id);
  });

  test("no registry connector sits in the not-in-the-tree table", () => {
    expect(planned).toBeDefined();
    const plannedIds = (planned?.rows ?? []).map((row) => row.cells[0] ?? "");
    expect(plannedIds.length).toBeGreaterThan(0);
    expect(plannedIds.filter((id) => ids.includes(id))).toEqual([]);
  });

  test("the Deferred section names Composio and WhatsApp Business API", () => {
    const sections = extractHeadings(DOC)
      .filter((heading) => heading.level === 3)
      .map((heading) => heading.text);
    expect(sections).toContain("Composio");
    expect(sections).toContain("WhatsApp Business API");
  });
});
