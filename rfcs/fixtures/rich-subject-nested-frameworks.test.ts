/** Design-only nested-framework containment. Direct observations only. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0003-rich-subject-foundation.md");
const MARKER = "<!-- rich-subject-nested-frameworks-example -->";
const TEXT =
  "The Cedar framework includes the Pine framework, which includes the Birch method.";
const EVENT_ID = "00000000000000000000000004";

type Anchor = { event_id: string; start_utf16: number; end_utf16: number };
type Discovery = {
  occurrence_id: string;
  label: string;
  class: string;
  anchor: Anchor;
};
type Observation = {
  observation_id: string;
  mode: string;
  container_occurrence_id: string;
  contained_occurrence_id: string;
  stated: boolean;
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
  expected: { discoveries: Discovery[]; observations: Observation[] };
};

function extractExample(markdown: string): Example {
  const at = markdown.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const fence = markdown.slice(at).match(/```json\n([\s\S]*?)\n```/);
  expect(fence?.[1]).toBeTypeOf("string");
  return JSON.parse(fence![1]!) as Example;
}

function nestedErrors(example: Example): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") errors.push("example must remain design_only");
  if (example.id !== "source-only-nested-frameworks") errors.push("unexpected example id");
  if (example.input.text !== TEXT) errors.push("unexpected source text");
  if (example.input.event_id !== EVENT_ID) errors.push("unexpected event id");
  if (example.input.supplied_refs.length !== 0) {
    errors.push("source-only input must not pre-resolve subject refs");
  }
  const discoveries = example.expected.discoveries;
  const observations = example.expected.observations;
  if (discoveries.length !== 3) errors.push("nested frameworks must keep three occurrences");
  const ids = new Set(discoveries.map((item) => item.occurrence_id));
  if (ids.size !== discoveries.length) errors.push("occurrences collapsed into one identity");
  for (const item of discoveries) {
    if (typeof item.occurrence_id !== "string" || item.occurrence_id.trim() === "") {
      errors.push("occurrence_id must be a nonempty string");
    }
    if (item.anchor.event_id !== EVENT_ID) errors.push(`${item.occurrence_id} left the source event`);
    const slice = TEXT.slice(item.anchor.start_utf16, item.anchor.end_utf16);
    if (slice !== item.label) errors.push(`${item.occurrence_id} anchor does not cover ${item.label}`);
  }
  const cedar = discoveries.find((item) => item.label === "Cedar");
  const pine = discoveries.find((item) => item.label === "Pine");
  const birch = discoveries.find((item) => item.label === "Birch");
  if (!cedar || cedar.class !== "framework") errors.push("missing framework Cedar");
  if (!pine || pine.class !== "framework") errors.push("missing framework Pine");
  if (!birch || birch.class !== "method") errors.push("missing method Birch");
  const cedarPine = observations.find(
    (item) =>
      item.mode === "contains" &&
      item.container_occurrence_id === cedar?.occurrence_id &&
      item.contained_occurrence_id === pine?.occurrence_id,
  );
  const pineBirch = observations.find(
    (item) =>
      item.mode === "contains" &&
      item.container_occurrence_id === pine?.occurrence_id &&
      item.contained_occurrence_id === birch?.occurrence_id,
  );
  if (!cedarPine) errors.push("missing Cedar contains Pine");
  if (!pineBirch) errors.push("missing Pine contains Birch");
  if (cedarPine && TEXT.slice(cedarPine.anchor.start_utf16, cedarPine.anchor.end_utf16) !== "includes the Pine framework") {
    errors.push("Cedar-Pine containment left its source anchor");
  }
  if (pineBirch && TEXT.slice(pineBirch.anchor.start_utf16, pineBirch.anchor.end_utf16) !== "includes the Birch method") {
    errors.push("Pine-Birch containment left its source anchor");
  }
  const directCedarBirch = observations.find(
    (item) =>
      item.stated &&
      item.mode === "contains" &&
      item.container_occurrence_id === cedar?.occurrence_id &&
      item.contained_occurrence_id === birch?.occurrence_id,
  );
  if (directCedarBirch) errors.push("direct Cedar-to-Birch presented as stated evidence");
  return errors;
}

test("the source-only nested-framework example preserves occurrences and containment direction", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(nestedErrors(example)).toEqual([]);
});

test("nested-framework counterexamples fail when grounding or containment collapses", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(nestedErrors(example)).toEqual([]);
  const cedar = example.expected.discoveries[0]!;
  const pine = example.expected.discoveries[1]!;
  const birch = example.expected.discoveries[2]!;
  const cedarPine = example.expected.observations[0]!;
  const pineBirch = example.expected.observations[1]!;
  const cases: Example[] = [
    { ...example, expected: { discoveries: [], observations: example.expected.observations } },
    {
      ...example,
      expected: {
        discoveries: [{ ...cedar, occurrence_id: pine.occurrence_id }, pine, birch],
        observations: example.expected.observations,
      },
    },
    {
      ...example,
      expected: {
        discoveries: example.expected.discoveries,
        observations: [
          { ...cedarPine, container_occurrence_id: pine.occurrence_id, contained_occurrence_id: cedar.occurrence_id },
          pineBirch,
        ],
      },
    },
    {
      ...example,
      expected: { discoveries: example.expected.discoveries, observations: [cedarPine] },
    },
    {
      ...example,
      expected: {
        discoveries: [cedar, pine, { ...birch, class: "framework" }],
        observations: example.expected.observations,
      },
    },
    {
      ...example,
      expected: {
        discoveries: [{ ...cedar, anchor: pine.anchor }, pine, birch],
        observations: example.expected.observations,
      },
    },
    {
      ...example,
      input: { ...example.input, supplied_refs: ["pre-resolved"] },
    },
    {
      ...example,
      expected: {
        discoveries: example.expected.discoveries,
        observations: [
          cedarPine,
          pineBirch,
          {
            observation_id: "cedar-contains-birch",
            mode: "contains",
            container_occurrence_id: cedar.occurrence_id,
            contained_occurrence_id: birch.occurrence_id,
            stated: true,
            anchor: cedarPine.anchor,
          },
        ],
      },
    },
  ];
  for (const broken of cases) {
    expect(nestedErrors(broken).length).toBeGreaterThan(0);
  }
});
