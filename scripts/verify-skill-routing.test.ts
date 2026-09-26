import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRoutingBundle,
  parseSkillCatalog,
  selectSkills,
  ROUTE_RULES,
  validateRouting,
} from "./skill-routing";

const root = join(import.meta.dir, "..");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function read(path: string): string {
  return decoder.decode(readFileSync(path));
}

const catalog = parseSkillCatalog(read(join(root, ".agents", "skills", "README.md")));
const agents = read(join(root, "AGENTS.md"));
const bundle = parseRoutingBundle(JSON.parse(read(join(root, "scripts", "skill-routing-fixtures.json"))));

describe("skill routing", () => {
  test("live catalog routes every committed fixture and invents no authority", () => {
    expect(validateRouting(catalog, bundle, agents)).toEqual([]);
  });

  test("a negated connector phrase does not select connector work", () => {
    expect(selectSkills(
      "Repair the bounded claim comparison. This is not a provider connector.",
      ROUTE_RULES,
      catalog,
    )).toEqual(["implement-change", "elegance-review"]);
  });

  test("an unsupported request selects nothing", () => {
    expect(selectSkills(
      "Translate this synthetic sentence into another synthetic sentence.",
      ROUTE_RULES,
      catalog,
    )).toEqual([]);
  });

  test("a missing catalog anchor fails closed", () => {
    const faded = new Map(catalog);
    faded.set("write-rfc", "Changing architecture only");
    expect(validateRouting(faded, bundle, agents)).toContain(
      "catalog anchor missing for write-rfc: binding contract",
    );
  });

  test("an AGENTS.md skill missing from the catalog fails closed", () => {
    const faded = new Map(catalog);
    faded.delete("handoff-work");
    expect(validateRouting(faded, bundle, agents)).toContain(
      "AGENTS.md skill is missing from the catalog: handoff-work",
    );
  });

  test("a malformed bundle is refused", () => {
    expect(() => parseRoutingBundle({ invented: ["merge-authority"], fixtures: [] })).toThrow(
      "fixtures must be a non-empty list",
    );
  });
});
