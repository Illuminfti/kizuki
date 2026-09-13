/** Design-only check of quoted disagreement. Quotation is not endorsement. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0003-rich-subject-foundation.md");
const MARKER = "<!-- rich-subject-quoted-disagreement-example -->";
const TEXT = "Mira: Theo wrote, “The Cedar method is best.” I disagree.";
const EVENT_ID = "00000000000000000000000003";

type Anchor = { event_id: string; start_utf16: number; end_utf16: number };
type Discovery = {
  occurrence_id: string;
  label: string;
  class: string;
  role: string;
  owner: boolean;
  anchor: Anchor;
};
type Observation = {
  observation_id: string;
  speaker_occurrence_id: string;
  mode: string;
  proposition?: string;
  target_observation_id?: string;
  endorsed_by_speaker: boolean;
  endorsed_by_owner: boolean;
  universal_dislike?: boolean;
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

function disagreementErrors(example: Example): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "design_only") errors.push("example must remain design_only");
  if (example.id !== "source-only-quoted-disagreement") errors.push("unexpected example id");
  if (example.input.text !== TEXT) errors.push("unexpected source text");
  if (example.input.event_id !== EVENT_ID) errors.push("unexpected event id");
  if (example.input.supplied_refs.length !== 0) {
    errors.push("source-only input must not pre-resolve subject refs");
  }
  const discoveries = example.expected.discoveries;
  const observations = example.expected.observations;
  if (discoveries.length !== 2) errors.push("quoted disagreement must keep two people");
  if (observations.length === 0) errors.push("no observations");
  const ids = new Set(discoveries.map((item) => item.occurrence_id));
  if (ids.size !== discoveries.length) errors.push("occurrences collapsed into one identity");
  for (const item of discoveries) {
    if (typeof item.occurrence_id !== "string" || item.occurrence_id.trim() === "") {
      errors.push("occurrence_id must be a nonempty string");
    }
    if (item.owner) errors.push(`${item.occurrence_id} invented owner attribution`);
    if (item.class !== "person") errors.push(`${item.occurrence_id} is not a person`);
    if (item.anchor.event_id !== EVENT_ID) errors.push(`${item.occurrence_id} left the source event`);
    const slice = TEXT.slice(item.anchor.start_utf16, item.anchor.end_utf16);
    if (slice !== item.label) errors.push(`${item.occurrence_id} anchor does not cover ${item.label}`);
  }
  const mira = discoveries.find((item) => item.role === "speaker");
  const theo = discoveries.find((item) => item.role === "quoted_author");
  if (!mira || mira.label !== "Mira") errors.push("missing speaker Mira");
  if (!theo || theo.label !== "Theo") errors.push("missing quoted author Theo");
  const quoted = observations.find((item) => item.mode === "quotation");
  const disagreement = observations.find((item) => item.mode === "disagreement");
  if (!quoted) errors.push("missing quoted proposition");
  if (!disagreement) errors.push("dropped the disagreement");
  if (quoted) {
    if (quoted.speaker_occurrence_id !== theo?.occurrence_id) {
      errors.push("quoted proposition was transferred off Theo");
    }
    if (quoted.speaker_occurrence_id === mira?.occurrence_id) {
      errors.push("quoted proposition was attributed to Mira");
    }
    if (quoted.endorsed_by_speaker || quoted.endorsed_by_owner) {
      errors.push("quotation became endorsement");
    }
    if (quoted.proposition !== "The Cedar method is best") {
      errors.push("quoted proposition drifted");
    }
    if (TEXT.slice(quoted.anchor.start_utf16, quoted.anchor.end_utf16) !== "The Cedar method is best") {
      errors.push("quoted proposition left its source anchor");
    }
  }
  if (disagreement) {
    if (disagreement.speaker_occurrence_id !== mira?.occurrence_id) {
      errors.push("disagreement left Mira");
    }
    if (disagreement.target_observation_id !== quoted?.observation_id) {
      errors.push("disagreement lost the quoted proposition");
    }
    if (disagreement.endorsed_by_speaker || disagreement.endorsed_by_owner) {
      errors.push("disagreement became endorsement");
    }
    if (disagreement.universal_dislike) {
      errors.push("disagreement was extrapolated into universal dislike");
    }
    if (TEXT.slice(disagreement.anchor.start_utf16, disagreement.anchor.end_utf16) !== "I disagree") {
      errors.push("disagreement left its source anchor");
    }
  }
  return errors;
}

test("the documented quoted disagreement keeps quotation distinct from endorsement", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(disagreementErrors(example)).toEqual([]);
});

test("quoted-disagreement counterexamples fail when attribution or polarity collapse", () => {
  const example = extractExample(readFileSync(RFC, "utf8"));
  expect(disagreementErrors(example)).toEqual([]);
  const mira = example.expected.discoveries[0]!;
  const theo = example.expected.discoveries[1]!;
  const quoted = example.expected.observations[0]!;
  const disagreement = example.expected.observations[1]!;
  const cases: Example[] = [
    { ...example, expected: { ...example.expected, observations: [] } },
    {
      ...example,
      expected: {
        ...example.expected,
        observations: [{ ...quoted, speaker_occurrence_id: mira.occurrence_id }, disagreement],
      },
    },
    {
      ...example,
      expected: {
        ...example.expected,
        observations: [{ ...quoted, endorsed_by_speaker: true }, disagreement],
      },
    },
    {
      ...example,
      expected: { discoveries: example.expected.discoveries, observations: [quoted] },
    },
    {
      ...example,
      expected: {
        discoveries: [{ ...mira, owner: true }, theo],
        observations: example.expected.observations,
      },
    },
    {
      ...example,
      expected: {
        ...example.expected,
        observations: [quoted, { ...disagreement, universal_dislike: true }],
      },
    },
    {
      ...example,
      expected: {
        ...example.expected,
        observations: [quoted, { ...disagreement, anchor: quoted.anchor }],
      },
    },
  ];
  for (const broken of cases) {
    expect(disagreementErrors(broken).length).toBeGreaterThan(0);
  }
});
