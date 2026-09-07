import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryInventory } from "./repository-inventory";

test("published inventory matches every workspace manifest and registered connector", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/repository-inventory.md"), "utf8");
  const start = "<!-- inventory:start -->\n";
  const end = "<!-- inventory:end -->";
  expect(doc.split(start)).toHaveLength(2);
  expect(doc.split(end)).toHaveLength(2);
  expect(doc.split(start)[1]!.split(end)[0]).toBe(repositoryInventory());
});
