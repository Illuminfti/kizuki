import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, listConnectorDescriptors } from "../src/registry";

const ROOT = join(import.meta.dir, "..", "..", "..");
const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const LEGACY_DOC = readFileSync(join(ROOT, "docs", "legacy-import.md"), "utf8");

/** Registry ids whose implementation lives in this package. */
function inTreeIds(): string[] {
  return listConnectorDescriptors()
    .filter(
      (descriptor) => descriptor.optional_package === "@kizuki/connectors",
    )
    .map((descriptor) =>
      descriptor.id.replace(/^kizuki\.connector\./, "kizuki."),
    )
    .sort();
}

/** `kizuki <verb> <connector>` invocations, fenced or inline. */
function commands(markdown: string): Array<{ verb: string; target: string }> {
  return [...markdown.matchAll(/kizuki ([a-z][a-z-]*) ([a-z][a-z-]*)/g)].map(
    (entry) => ({
      verb: entry[1] as string,
      target: entry[2] as string,
    }),
  );
}

describe("packages/connectors/README.md", () => {
  test("every connector implemented here is a row in the registry table", () => {
    const ids = inTreeIds();
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(id in REGISTRY).toBe(true);
      if (id.startsWith("kizuki.import-legacy-")) {
        // The estate importers are documented with their mapping files.
        expect(LEGACY_DOC).toContain(`\`${id}\``);
        continue;
      }
      expect(README).toContain(`| \`${id}\``);
    }
  });

  test("every documented connector is reachable by a command that names it", () => {
    const enrollable = new Set(
      commands(README)
        .filter(({ verb }) => verb === "import" || verb === "connect")
        .map(({ target }) => `kizuki.${target}`),
    );
    for (const id of inTreeIds()) {
      if (id.startsWith("kizuki.import-legacy-")) continue;
      expect(enrollable.has(id)).toBe(true);
    }
  });

  test("every command the README shows names a verb and a connector this revision has", () => {
    const cli = readFileSync(
      join(ROOT, "packages", "cli", "src", "commands", "index.ts"),
      "utf8",
    );
    const verbs = new Set(
      [...cli.matchAll(/^  (\w+)Command,$/gm)].map(
        (entry) => entry[1] as string,
      ),
    );
    const named = commands(README);
    expect(named.length).toBeGreaterThan(0);
    for (const { verb, target } of named) {
      expect(verbs.has(verb)).toBe(true);
      if (verb === "import" || verb === "connect" || verb === "backfill") {
        expect(`kizuki.${target}` in REGISTRY).toBe(true);
      }
    }
  });

  test("the snapshot importers are never called a live sync", () => {
    const registryTable = README.slice(
      README.indexOf("## The registry"),
      README.indexOf("## What the command line can pass"),
    );
    for (const line of registryTable.split("\n")) {
      if (!line.includes("kizuki.import-")) continue;
      expect(line).toContain("Snapshot importer");
    }
  });
});
