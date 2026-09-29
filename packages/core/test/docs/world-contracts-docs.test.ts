/**
 * The world-model amendment record (RFC 0004, Amendments), the domain contracts
 * appendix (RFC 0004, Appendix B) and the proposed decision rows must be
 * complete and must only name things that exist in the RFC set: relative links
 * and anchors, schema ids, predicates and fixture ids.
 */
import { expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PREDICATE_REGISTRY } from "../../src/claims/predicates";

setDefaultTimeout(30_000);

const ROOT = join(import.meta.dir, "../../../..");
const RFC_PATH = "rfcs/0004-living-epistemic-world-model.md";
const APPENDIX_B_PATH = "rfcs/0004-domain-contracts.md";
const DECISIONS_PATH = "docs/world/decisions-proposed.md";
const PROGRAM_PATH = "docs/world-model-program.md";

const EM_DASH = "—";
const MACHINE_PATH_FRAGMENTS = ["/hom" + "e/", "/da" + "ta/", "/Us" + "ers/"];

const AMENDMENT_TITLES = [
  /^Amendment 1: .*sequence history/i,
  /^Amendment 2: .*v2 selector on behalf of scoped clients/i,
  /^Amendment 3: .*reserved at enrolment/i,
  /^Amendment 4: .*[Rr]esume handle/,
  /^Amendment 5: .*[Ss]ummary basis/,
  /^Amendment 6: .*[Oo]utcomes through propose/,
  /^Amendment 7: .*[Aa]ttention and forecast record classes/,
  /^Amendment 8: .*operation family and describe/,
  /^Amendment 9: .*quoted channel/,
  /^Amendment 10: .*order independence/,
  /^Amendment 11: .*[Ii]dentity subset/,
  /^Amendment 12: .*Situation vocabulary/,
] as const;

const DOMAIN_CONTRACTS = [
  "Question",
  "Person",
  "Skill",
  "Framework",
  "Procedure",
  "Commitment",
  "Decision",
  "Situation v2",
  "ArtifactVersion",
  "WorldSlice",
  "WorldDiff",
  "Attention",
  "Outcome",
  "Forecast",
  "Atlas",
  "ResumeHandle",
] as const;

const CONTRACTS_WITH_PREDICATES = new Set<string>([
  "Question",
  "Person",
  "Skill",
  "Framework",
  "Procedure",
  "Commitment",
  "Decision",
  "Situation v2",
  "ArtifactVersion",
  "Outcome",
]);

const VIEW_GAPS = new Set([
  "coverage",
  "pending_consolidation",
  "stale_dependencies",
  "required_context_overflow",
  "traversal_limit",
]);

const NON_PREDICATE_EXTENSIONS = new Set([
  "ts",
  "js",
  "md",
  "json",
  "sql",
  "sh",
  "txt",
  "yaml",
  "yml",
  "lock",
]);

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function readIfPresent(relative: string): string {
  return existsSync(join(ROOT, relative)) ? read(relative) : "";
}

/** Lines outside fenced code blocks; fenced lines are returned blank so offsets stay meaningful. */
function proseLines(markdown: string): string[] {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  });
}

export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of proseLines(markdown)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined) slugs.add(slugify(match[1]));
  }
  return slugs;
}

/** Body of the `## ` section whose heading starts with `prefix`, up to the next `## ` heading. */
export function level2Section(markdown: string, prefix: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${prefix}`));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Sub-sections of a section at the given heading level, keyed by heading text. */
export function subsections(section: string, level: 3): Map<string, string> {
  const marker = "#".repeat(level);
  const result = new Map<string, string>();
  const lines = section.split("\n");
  let title: string | null = null;
  let body: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (title !== null) result.set(title, body.join("\n"));
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match =
      !fenced && line.startsWith(`${marker} `)
        ? line.slice(marker.length + 1).trim()
        : null;
    if (match !== null) {
      flush();
      title = match;
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  flush();
  return result;
}

export function labelled(body: string, label: string): string | null {
  const start = body.search(new RegExp(`^\\*\\*${label}:\\*\\*`, "m"));
  if (start < 0) return null;
  const rest = body
    .slice(start)
    .replace(new RegExp(`^\\*\\*${label}:\\*\\*`), "");
  const next = rest.search(/^\*\*[A-Za-z ]+:\*\*|^#{1,6} /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

type Link = { readonly target: string };

export function relativeLinks(markdown: string): Link[] {
  const links: Link[] = [];
  for (const line of proseLines(markdown)) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      links.push({ target });
    }
  }
  return links;
}

export function brokenLinks(markdown: string, fromRelative: string): string[] {
  const broken: string[] = [];
  const baseDir = dirname(join(ROOT, fromRelative));
  for (const { target } of relativeLinks(markdown)) {
    const [path = "", anchor] = target.split("#");
    const file =
      path === "" ? join(ROOT, fromRelative) : resolve(baseDir, path);
    if (!existsSync(file)) {
      broken.push(`${target}: file does not exist`);
      continue;
    }
    if (anchor !== undefined && anchor !== "" && file.endsWith(".md")) {
      if (!headingSlugs(readFileSync(file, "utf8")).has(anchor))
        broken.push(`${target}: anchor does not exist`);
    }
  }
  return broken;
}

const SCHEMA_ID = /kizuki\.[a-z0-9-]+\/v[0-9]+/g;

export function schemaIds(markdown: string): string[] {
  return [...new Set(markdown.match(SCHEMA_ID) ?? [])];
}

/** Rows of every markdown table whose header starts with `firstHeader`; the first cell of each row. */
export function tableFirstCells(
  markdown: string,
  firstHeader: string,
): string[] {
  const cells: string[] = [];
  const lines = proseLines(markdown);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("|")) continue;
    const header = line.split("|")[1]?.trim() ?? "";
    if (!header.startsWith(firstHeader)) continue;
    for (
      let row = index + 2;
      row < lines.length && (lines[row] ?? "").startsWith("|");
      row += 1
    ) {
      cells.push((lines[row] ?? "").split("|")[1]?.trim() ?? "");
    }
  }
  return cells;
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
}

export function declaredPredicates(markdown: string): Set<string> {
  const declared = new Set<string>();
  for (const cell of tableFirstCells(markdown, "Predicate")) {
    for (const token of backticked(cell)) declared.add(token);
  }
  return declared;
}

const PREDICATE_SHAPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

/** Backticked lowercase dotted identifiers that are not files, i.e. predicate references. */
export function predicateReferences(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of proseLines(markdown)) {
    for (const token of backticked(line)) {
      if (!PREDICATE_SHAPE.test(token)) continue;
      const extension = token.split(".").at(-1) ?? "";
      if (NON_PREDICATE_EXTENSIONS.has(extension)) continue;
      found.add(token);
    }
  }
  return [...found];
}

function rfcSet(): Map<string, string> {
  const files = [
    "rfcs/0000-constraints.md",
    "rfcs/0001-deep-model-arbitration.md",
    "rfcs/0002-autonomous-canon.md",
    "rfcs/0003-rich-subject-foundation.md",
    RFC_PATH,
    "rfcs/0004-typed-canon-implementation.md",
    "rfcs/0004-world-read-implementation.md",
    "rfcs/0004-world-storage.md",
    "rfcs/0005-optional-systemone.md",
  ];
  return new Map(files.map((path) => [path, read(path)]));
}

const rfc = read(RFC_PATH);
const amendments = level2Section(rfc, "Amendments");
const appendixB = readIfPresent(APPENDIX_B_PATH);
const decisions = readIfPresent(DECISIONS_PATH);
const program = read(PROGRAM_PATH);

/** Schema ids and predicates that exist independently of the sections under test. */
function independentSchemaIds(): Set<string> {
  const ids = new Set<string>();
  for (const [path, text] of rfcSet()) {
    const body = path === RFC_PATH ? text.replace(amendments, "") : text;
    for (const id of schemaIds(body)) ids.add(id);
  }
  return ids;
}

function declaredSchemaIds(): Set<string> {
  const declared = independentSchemaIds();
  for (const cell of tableFirstCells(appendixB, "Schema")) {
    for (const token of backticked(cell)) declared.add(token);
  }
  return declared;
}

function declaredPredicateSet(): Set<string> {
  const declared = new Set<string>(PREDICATE_REGISTRY.map((entry) => entry.id));
  for (const [, text] of rfcSet())
    for (const id of declaredPredicates(text)) declared.add(id);
  for (const id of declaredPredicates(appendixB)) declared.add(id);
  for (const id of declaredPredicates(amendments)) declared.add(id);
  return declared;
}

function fixtureExists(id: string): boolean {
  return ["", "-design"]
    .map((suffix) => `rfcs/fixtures/${id}${suffix}.json`)
    .concat([`rfcs/fixtures/${id}.test.ts`])
    .some((path) => existsSync(join(ROOT, path)));
}

export function unresolvedFixtureIds(markdown: string): string[] {
  const missing: string[] = [];
  for (const line of proseLines(markdown)) {
    const match = /^\*\*Oracle fixtures:\*\*(.*)$/.exec(line.trim());
    if (match === null) continue;
    for (const id of backticked(match[1] ?? ""))
      if (!fixtureExists(id)) missing.push(id);
  }
  return missing;
}

test("RFC 0004 links its amendment record and Appendix B, and keeps its status line", () => {
  const status =
    rfc.split("\n").find((line) => line.startsWith("Status:")) ?? "";
  expect(status).toContain("Accepted as a minimal slice");
  expect(status).toContain("remains Proposed");
  const header = rfc.split("\n").slice(0, 20).join("\n");
  expect(header).toContain("0004-domain-contracts.md");
  expect(header).toContain("#amendments");
  expect(amendments).toContain("Every amendment below is Proposed");
});

test("the amendment record lists all twelve deviations, each with changes, rule, reason and status", () => {
  const entries = [...subsections(amendments, 3)];
  expect(entries.map(([title]) => title).length).toBe(AMENDMENT_TITLES.length);
  const problems: string[] = [];
  AMENDMENT_TITLES.forEach((pattern, index) => {
    const entry = entries[index];
    if (entry === undefined || !pattern.test(entry[0])) {
      problems.push(
        `amendment ${index + 1}: heading ${JSON.stringify(entry?.[0])} does not match ${pattern}`,
      );
      return;
    }
    for (const label of ["Changes", "New rule", "Reason", "Status"]) {
      const text = labelled(entry[1], label);
      if (text === null || text.length < 40)
        problems.push(`amendment ${index + 1}: missing or empty ${label}`);
    }
    const changes = labelled(entry[1], "Changes") ?? "";
    if (relativeLinks(changes).length === 0)
      problems.push(`amendment ${index + 1}: Changes names no linked section`);
    const status = labelled(entry[1], "Status") ?? "";
    if (!status.includes("Proposed"))
      problems.push(`amendment ${index + 1}: status is not Proposed`);
    const rows = backticked(status).filter((token) =>
      /^PD-[A-Z0-9-]+$/.test(token),
    );
    if (rows.length === 0)
      problems.push(`amendment ${index + 1}: names no proposed decision row`);
    for (const row of rows) {
      if (
        !tableFirstCells(decisions, "ID").some((cell) =>
          backticked(cell).includes(row),
        )
      ) {
        problems.push(
          `amendment ${index + 1}: ${row} is not a row of ${DECISIONS_PATH}`,
        );
      }
    }
  });
  expect(problems).toEqual([]);
});

test("proposed decision rows exist for the owner and never edit the decision log", () => {
  expect(decisions.length).toBeGreaterThan(0);
  expect(decisions).toContain("docs/decision-log.md");
  expect(decisions).toMatch(/never edits? `?docs\/decision-log\.md`?/i);
  const ids = tableFirstCells(decisions, "ID").flatMap((cell) =>
    backticked(cell),
  );
  expect(new Set(ids).size).toBe(ids.length);
  for (const required of [
    "PD-HISTORY",
    "PD-ENV",
    "PD-PART",
    "PD-RESUME",
    "PD-IDENT",
    "PD-OUTCOME",
    "PD-FORECAST",
  ]) {
    expect(ids).toContain(required);
  }
});

test("Appendix B defines every domain contract with a codec sketch, fixtures, gap use and a fallback", () => {
  expect(appendixB.length).toBeGreaterThan(0);
  const status =
    appendixB.split("\n").find((line) => line.startsWith("Status:")) ?? "";
  expect(status).toContain("Proposed");
  expect(status).toContain("not implemented");
  const sections = subsections(appendixB, 3);
  const problems: string[] = [];
  for (const name of DOMAIN_CONTRACTS) {
    const body = sections.get(name);
    if (body === undefined) {
      problems.push(`${name}: section is missing`);
      continue;
    }
    if (!/```ts\n[\s\S]*?```/.test(body))
      problems.push(`${name}: no closed codec sketch`);
    const fixtures = labelled(body, "Oracle fixtures") ?? "";
    if (backticked(fixtures).length === 0)
      problems.push(`${name}: names no oracle fixture`);
    const gaps = labelled(body, "Gap use");
    if (gaps === null) problems.push(`${name}: no Gap use line`);
    for (const gap of backticked(gaps ?? "")) {
      if (gap !== "none" && !VIEW_GAPS.has(gap))
        problems.push(`${name}: ${gap} is not a ViewGap`);
    }
    if ((labelled(body, "Fallback") ?? "").length < 20)
      problems.push(`${name}: no honest fallback`);
    const hasPredicateTable = tableFirstCells(body, "Predicate").length > 0;
    if (CONTRACTS_WITH_PREDICATES.has(name) !== hasPredicateTable) {
      problems.push(
        `${name}: predicate table ${hasPredicateTable ? "present" : "absent"} against its contract`,
      );
    }
  }
  expect(problems).toEqual([]);
});

test("every oracle fixture named in Appendix B is a fixture in this repository", () => {
  expect(unresolvedFixtureIds(appendixB)).toEqual([]);
  expect(
    unresolvedFixtureIds("**Oracle fixtures:** `world-does-not-exist`"),
  ).toEqual(["world-does-not-exist"]);
});

test("every relative link and anchor in the amendments, Appendix B and decision rows resolves", () => {
  expect(brokenLinks(amendments, RFC_PATH)).toEqual([]);
  expect(brokenLinks(appendixB, APPENDIX_B_PATH)).toEqual([]);
  expect(brokenLinks(decisions, DECISIONS_PATH)).toEqual([]);
  expect(brokenLinks(program, PROGRAM_PATH)).toEqual([]);
  expect(
    brokenLinks("[x](0004-world-storage.md#no-such-heading)", RFC_PATH).length,
  ).toBe(1);
  expect(brokenLinks("[x](no-such-file.md)", RFC_PATH).length).toBe(1);
});

test("every schema id named in the amendments and Appendix B exists in the RFC set", () => {
  const declared = declaredSchemaIds();
  const unknown = [
    ...schemaIds(amendments),
    ...schemaIds(appendixB),
    ...schemaIds(decisions),
  ].filter((id) => !declared.has(id));
  expect(unknown).toEqual([]);
  expect(
    [...schemaIds("uses kizuki.no-such-schema/v9")].filter(
      (id) => !declared.has(id),
    ),
  ).toEqual(["kizuki.no-such-schema/v9"]);
});

test("every predicate named in the amendments and Appendix B is declared in the RFC set or the legacy registry", () => {
  const declared = declaredPredicateSet();
  const unknown = [
    ...predicateReferences(amendments),
    ...predicateReferences(appendixB),
    ...predicateReferences(decisions),
  ].filter((id) => !declared.has(id));
  expect(unknown).toEqual([]);
  expect(
    predicateReferences("names `question.no_such` and `versions.ts`"),
  ).toEqual(["question.no_such"]);
  expect(declared.has("question.text")).toBe(true);
  expect(declared.has("outcome.reached")).toBe(true);
});

test("the appendix predicates that extend the shipped registry keep the existing rows unchanged", () => {
  const shipped = read("packages/core/src/contracts/world-vocabulary.ts");
  const body = appendixB.replace(/```[\s\S]*?```/g, "");
  for (const id of [
    "concept.label",
    "concept.definition",
    "learning.assistance",
    "world.kind",
  ]) {
    expect(shipped).toContain(`"${id}"`);
    expect(declaredPredicateSet().has(id)).toBe(true);
  }
  expect(body).toContain("existing rows are pinned");
});

test("the new documents use plain sentences: no em dashes and no machine paths", () => {
  const documents: Array<[string, string]> = [
    ["amendments", amendments],
    ["appendix B", appendixB],
    ["decision rows", decisions],
    ["program guide", program],
  ];
  for (const [name, text] of documents) {
    expect([name, text.includes(EM_DASH)]).toEqual([name, false]);
    for (const fragment of MACHINE_PATH_FRAGMENTS)
      expect([name, text.includes(fragment)]).toEqual([name, false]);
  }
});

test("the program guide points at the amendment record and Appendix B and still calls them proposals", () => {
  expect(program).toContain("0004-domain-contracts.md");
  expect(program).toContain("#amendments");
  expect(program).toMatch(
    /amendment record[^.]*Proposed|Proposed[^.]*amendment record/i,
  );
});
