import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillCatalog = ReadonlyMap<string, string>;

export type RouteRule = {
  readonly skill: string;
  readonly anchor: string;
  readonly allOf: readonly string[];
  readonly noneOf: readonly string[];
};

export type RoutingFixture = {
  readonly id: string;
  readonly request: string;
  readonly expect: readonly string[];
  readonly reject: readonly string[];
};

export type RoutingBundle = {
  readonly invented: readonly string[];
  readonly fixtures: readonly RoutingFixture[];
};

// These phrases are checked against `.agents/skills/README.md`. A renamed
// catalog row fails closed instead of silently selecting a parallel policy.
export const ROUTE_RULES: readonly RouteRule[] = [
  {
    skill: "repository-archaeology",
    anchor: "unfamiliar code",
    allOf: ["explain", "unfamiliar", "do not change"],
    noneOf: [],
  },
  {
    skill: "implement-change",
    anchor: "repairing a bounded behavior",
    allOf: ["repair the bounded"],
    noneOf: ["do not change", "do not edit", "cause is uncertain"],
  },
  {
    skill: "diagnose-failure",
    anchor: "failure cause is uncertain",
    allOf: ["cause is uncertain"],
    noneOf: [],
  },
  {
    skill: "review-change",
    anchor: "pull-request head",
    allOf: ["review the pull request", "exact head"],
    noneOf: [],
  },
  {
    skill: "connector-work",
    anchor: "provider connector or importer",
    allOf: ["provider connector"],
    noneOf: [],
  },
  {
    skill: "write-rfc",
    anchor: "binding contract",
    allOf: ["multi-phase plan", "binding contract"],
    noneOf: ["schedule workers"],
  },
];

const CODE_ROUTES = new Set(["implement-change", "connector-work", "review-change"]);

const ELEGANCE_ANCHOR = "every implementation, refactor, or pr review";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "" || item !== item.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty trimmed string`);
    }
    return item;
  });
}

// A negated phrase is not a request for that route.
function includesPhrase(haystack: string, needle: string): boolean {
  const text = haystack.toLowerCase();
  const token = needle.toLowerCase();
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = text.slice(Math.max(0, at - 12), at);
    if (!/(?:^|\s)not(?:\s+a)?\s*$/.test(before)) return true;
    from = at + token.length;
  }
  return false;
}

export function parseSkillCatalog(markdown: string): Map<string, string> {
  const catalog = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    const skill = match?.[1];
    const useWhen = match?.[2];
    if (skill === undefined || useWhen === undefined) continue;
    if (skill === "Skill" || skill === "---") continue;
    catalog.set(skill, useWhen.trim());
  }
  return catalog;
}

export function skillsReferencedByAgents(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(/\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

export function parseRoutingBundle(value: unknown): RoutingBundle {
  if (!isRecord(value)) throw new Error("routing bundle must be an object");
  const invented = stringList(value["invented"], "invented");
  if (!Array.isArray(value["fixtures"]) || value["fixtures"].length === 0) {
    throw new Error("fixtures must be a non-empty list");
  }
  const fixtures = value["fixtures"].map((fixture, index) => {
    if (!isRecord(fixture)) throw new Error(`fixtures[${index}] must be an object`);
    const id = fixture["id"];
    const request = fixture["request"];
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) {
      throw new Error(`fixtures[${index}].id must be a non-empty trimmed string`);
    }
    if (typeof request !== "string" || request.trim() === "") {
      throw new Error(`fixtures[${index}].request must be non-empty`);
    }
    return {
      id,
      request,
      expect: stringList(fixture["expect"], `fixtures[${index}].expect`),
      reject: stringList(fixture["reject"], `fixtures[${index}].reject`),
    };
  });
  return { invented, fixtures };
}

export function selectSkills(
  request: string,
  rules: readonly RouteRule[],
  catalog: SkillCatalog,
): string[] {
  const matched = rules.filter((rule) => {
    if (!catalog.has(rule.skill) || rule.allOf.length === 0) return false;
    return rule.allOf.every((phrase) => includesPhrase(request, phrase))
      && rule.noneOf.every((phrase) => !includesPhrase(request, phrase));
  }).map((rule) => rule.skill);

  const selected = matched.includes("implement-change") && matched.length > 1
    ? matched.filter((skill) => skill !== "implement-change")
    : [...matched];

  // AGENTS.md loads elegance-review for implementation, connector, and review
  // work. A read-only or diagnostic request does not become a code change.
  if (selected.some((skill) => CODE_ROUTES.has(skill)) && catalog.has("elegance-review")) {
    selected.push("elegance-review");
  }
  return selected;
}

export function validateRouting(
  catalog: SkillCatalog,
  bundle: RoutingBundle,
  agentsMarkdown: string,
): string[] {
  const errors: string[] = [];
  const invented = new Set(bundle.invented);
  if (agentsMarkdown.trim() === "") errors.push("AGENTS.md is empty");
  const referenced = skillsReferencedByAgents(agentsMarkdown);
  if (referenced.length === 0) errors.push("AGENTS.md names no canonical skills");
  for (const skill of referenced) {
    if (!catalog.has(skill)) errors.push(`AGENTS.md skill is missing from the catalog: ${skill}`);
  }
  for (const name of invented) {
    if (catalog.has(name)) errors.push(`invented capability is a real skill: ${name}`);
  }
  for (const rule of ROUTE_RULES) {
    const useWhen = catalog.get(rule.skill);
    if (useWhen === undefined) {
      errors.push(`rule skill is not in the catalog: ${rule.skill}`);
      continue;
    }
    if (!useWhen.toLowerCase().includes(rule.anchor.toLowerCase())) {
      errors.push(`catalog anchor missing for ${rule.skill}: ${rule.anchor}`);
    }
    if (invented.has(rule.skill)) errors.push(`rule uses an invented capability: ${rule.skill}`);
  }
  const elegance = catalog.get("elegance-review");
  if (elegance === undefined || !elegance.toLowerCase().includes(ELEGANCE_ANCHOR)) {
    errors.push("catalog anchor missing for elegance-review");
  }
  const seen = new Set<string>();
  for (const fixture of bundle.fixtures) {
    if (seen.has(fixture.id)) errors.push(`duplicate fixture: ${fixture.id}`);
    seen.add(fixture.id);
    const selected = selectSkills(fixture.request, ROUTE_RULES, catalog);
    const selectedSet = new Set(selected);
    for (const skill of selected) {
      if (!catalog.has(skill)) errors.push(`${fixture.id}: selected unknown skill ${skill}`);
      if (invented.has(skill)) errors.push(`${fixture.id}: invented capability selected: ${skill}`);
    }
    for (const expected of fixture.expect) {
      if (!selectedSet.has(expected)) errors.push(`${fixture.id}: missing expected route ${expected}`);
      if (!catalog.has(expected)) errors.push(`${fixture.id}: expected route is not a catalog skill: ${expected}`);
    }
    for (const rejected of fixture.reject) {
      if (selectedSet.has(rejected)) errors.push(`${fixture.id}: rejected route selected: ${rejected}`);
    }
    for (const skill of selected) {
      if (!fixture.expect.includes(skill)) errors.push(`${fixture.id}: unexpected route ${skill}`);
    }
  }
  return errors;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

if (import.meta.main) {
  try {
    const root = join(import.meta.dir, "..");
    const read = (path: string): string => decoder.decode(readFileSync(path));
    const catalog = parseSkillCatalog(read(join(root, ".agents", "skills", "README.md")));
    const agents = read(join(root, "AGENTS.md"));
    const bundle = parseRoutingBundle(JSON.parse(read(join(root, "scripts", "skill-routing-fixtures.json"))));
    const errors = validateRouting(catalog, bundle, agents);
    for (const error of errors) console.error(error);
    if (errors.length > 0) process.exitCode = 1;
    else console.log("skill routing verification passed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "skill routing verification failed");
    process.exitCode = 1;
  }
}
