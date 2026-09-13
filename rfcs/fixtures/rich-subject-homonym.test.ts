/** Design-only check of the documented source-only person/company homonym. Not discovery quality. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0003-rich-subject-foundation.md");
const MARKER = "<!-- rich-subject-homonym-example -->";
const TEXT = "A person named Atlas joined a company named Atlas.";
const EVENT_ID = "00000000000000000000000002";

type Anchor = { event_id: string; start_utf16: number; end_utf16: number };
type Discovery = {
  occurrence_id: string;
  label: string;
  class: string;
  anchor: Anchor;
};
type Example = {
  id: string;
  evaluation_state: string;
  input: {
    source_key: string;
    event_id: string;
    text: string;
    supplied_refs: unknown[];
  };
  expected: { discoveries: Discovery[] };
};

function extractExample(markdown: string): Example {
  const at = markdown.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const fence = markdown.slice(at).match(/```json\n([\s\S]*?)\n```/);
  expect(fence?.[1]).toBeTypeOf("string");
  return JSON.parse(fence![1]!) as Example;
}

function anchorKey(anchor: Anchor): string {
  return `${anchor.event_id}:${anchor.start_utf16}:${anchor.end_utf16}`;
}

function homonymErrors(example: Example): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") {
    errors.push("example must remain design_only");
  }
  if (example.id !== "source-only-person-company-homonym") {
    errors.push("unexpected example id");
  }
  if (example.input.text !== TEXT) errors.push("unexpected source text");
  if (example.input.event_id !== EVENT_ID) errors.push("unexpected event id");
  if (example.input.supplied_refs.length !== 0) {
    errors.push("source-only input must not pre-resolve subject refs");
  }
  const discoveries = example.expected.discoveries;
  if (discoveries.length === 0) errors.push("no discoveries");
  if (discoveries.length !== 2) errors.push("homonym must keep two occurrences");
  for (const item of discoveries) {
    if (typeof item.occurrence_id !== "string" || item.occurrence_id.trim() === "") {
      errors.push("occurrence_id must be a nonempty string");
    }
  }
  const ids = new Set(discoveries.map((item) => item.occurrence_id));
  if (ids.size !== discoveries.length) errors.push("occurrences collapsed into one identity");
  const anchors = new Set(discoveries.map((item) => anchorKey(item.anchor)));
  if (anchors.size !== discoveries.length) errors.push("occurrence reused another source anchor");
  const person = discoveries.find((item) => item.class === "person");
  const organization = discoveries.find((item) => item.class === "organization");
  if (!person) errors.push("missing person classification");
  if (!organization) errors.push("missing organization classification");
  for (const item of discoveries) {
    if (item.label !== "Atlas") errors.push(`${item.occurrence_id} lost the Atlas label`);
    if (item.anchor.event_id !== EVENT_ID) errors.push(`${item.occurrence_id} left the source event`);
    const slice = TEXT.slice(item.anchor.start_utf16, item.anchor.end_utf16);
    if (slice !== "Atlas") errors.push(`${item.occurrence_id} anchor does not cover Atlas`);
  }
  if (person && (person.anchor.start_utf16 !== 15 || person.anchor.end_utf16 !== 20)) {
    errors.push("person reused the wrong occurrence's anchor");
  }
  if (
    organization &&
    (organization.anchor.start_utf16 !== 44 || organization.anchor.end_utf16 !== 49)
  ) {
    errors.push("organization reused the wrong occurrence's anchor");
  }
  return errors;
}

test("the documented source-only homonym keeps person and company Atlas distinct", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(homonymErrors(example)).toEqual([]);
});

test("homonym counterexamples fail when identities, classes, or anchors collapse", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  const person = example.expected.discoveries[0]!;
  const company = example.expected.discoveries[1]!;
  const cases: Example[] = [
    {
      ...example,
      expected: { discoveries: [] },
    },
    {
      ...example,
      expected: { discoveries: [{ ...person, occurrence_id: "atlas" }, { ...company, occurrence_id: "atlas" }] },
    },
    {
      ...example,
      expected: { discoveries: [{ ...person, class: "organization" }, company] },
    },
    {
      ...example,
      expected: { discoveries: [{ ...person, anchor: company.anchor }, company] },
    },
  ];
  for (const broken of cases) {
    expect(homonymErrors(broken).length).toBeGreaterThan(0);
  }
});

test("homonym occurrence ids must be nonempty strings", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(homonymErrors(example)).toEqual([]);
  const person = example.expected.discoveries[0]!;
  const company = example.expected.discoveries[1]!;
  const blankIds: Array<string | undefined> = ["", "   ", undefined];
  for (const target of [person, company]) {
    for (const occurrence_id of blankIds) {
      const { occurrence_id: _ignored, ...rest } = target;
      const mutated = occurrence_id === undefined ? rest : { ...target, occurrence_id };
      const broken: Example = {
        ...example,
        expected: {
          discoveries: example.expected.discoveries.map((item) =>
            item === target ? (mutated as Discovery) : item,
          ),
        },
      };
      expect(homonymErrors(broken).length).toBeGreaterThan(0);
    }
  }
});
