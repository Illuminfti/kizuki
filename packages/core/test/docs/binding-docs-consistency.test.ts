/**
 * The two instruction files a new agent reads first must not point at a closed
 * handoff issue or a superseded 1.0 definition, and no tracked document may
 * call the world-storage appendix an RFC.
 */
import { expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const ROOT = join(import.meta.dir, "../../../..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function trackedMarkdown(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "*.md"], { cwd: ROOT, encoding: "utf8" });
  expect(listed.status).toBe(0);
  return listed.stdout.split("\0").filter((path) => path.length > 0);
}

/** A handoff pointer is stale when it tells the reader to trust issue #4. */
export function closedHandoffClaims(text: string): string[] {
  const errors: string[] = [];
  if (/issue #4\b(?![0-9])[^.]*durable handoff/is.test(text)) {
    errors.push("still names issue #4 as the durable handoff");
  }
  if (/^\s*gh issue view 4\s*$/m.test(text)) {
    errors.push("still tells the reader to open issue #4 for live campaign state");
  }
  return errors;
}

/**
 * A 1.0 definition is stale when it still carries C1's estate-cutover
 * prerequisite. D19 superseded it, so contributor instructions cite the
 * decision by id instead of repeating the retired phrase.
 */
export function supersededReleaseDefinitionClaims(text: string): string[] {
  const collapsed = text.replace(/\s+/g, " ");
  return /estate[-\s]?cutover/i.test(collapsed)
    ? ["still carries the estate-cutover prerequisite for 1.0"]
    : [];
}

/**
 * `rfcs/0004-world-storage.md` is Appendix A to RFC 0004, not a second RFC.
 * Naming it as one, or labelling a link to it "RFC ...", makes the appendix
 * look like a separate binding document.
 */
export function appendixMiscitedAsRfc(text: string): string[] {
  const errors: string[] = [];
  if (/RFC\s*0004[-\s]world[-\s]storage/i.test(text)) {
    errors.push("cites the world-storage appendix as an RFC by name");
  }
  if (/\[\s*RFC\b[^\]]*\]\([^)]*0004-world-storage\.md[^)]*\)/i.test(text)) {
    errors.push("labels a link to the world-storage appendix as an RFC");
  }
  return errors;
}

test("AGENTS.md does not anchor a new agent on the closed handoff issue", () => {
  const agents = read("AGENTS.md");
  expect(closedHandoffClaims(agents)).toEqual([]);
  expect(agents).toContain("#497");
});

test("CONTRIBUTING.md states the 1.0 bar the decision log actually records", () => {
  const contributing = read("CONTRIBUTING.md");
  expect(supersededReleaseDefinitionClaims(contributing)).toEqual([]);
  expect(contributing).toMatch(/\bD19\b/);
  expect(contributing).toMatch(/\bD21\b/);
});

test("no tracked document calls the world-storage appendix an RFC", () => {
  const offenders: string[] = [];
  for (const path of trackedMarkdown()) {
    for (const error of appendixMiscitedAsRfc(read(path))) offenders.push(`${path}: ${error}`);
  }
  expect(offenders).toEqual([]);
});

test("the stale phrasings this gate retired still fail it", () => {
  expect(closedHandoffClaims("While issue #4 is open and not superseded, treat it as the durable handoff.").length)
    .toBeGreaterThan(0);
  expect(closedHandoffClaims("```bash\ngh issue view 4\n```").length).toBeGreaterThan(0);
  expect(supersededReleaseDefinitionClaims("1.0 is stranger proof plus estate\ncutover; neither is done.").length)
    .toBeGreaterThan(0);
  expect(appendixMiscitedAsRfc("See RFC 0004-world-storage for the codec.").length).toBeGreaterThan(0);
  expect(appendixMiscitedAsRfc("[RFC 0004 storage](rfcs/0004-world-storage.md)").length).toBeGreaterThan(0);
});

test("the appendix gate accepts the appendix named as an appendix", () => {
  const honest = "The [storage and codec appendix (Appendix A to this RFC)](0004-world-storage.md) gives the codec.";
  expect(appendixMiscitedAsRfc(honest)).toEqual([]);
});
