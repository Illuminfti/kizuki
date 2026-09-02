import { describe, expect, test } from "bun:test";
import {
  PAGE_CANDIDATE_KEY,
  validateEventInput,
  validatePageCandidate,
} from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import {
  LEGACY_WIKI_FIXTURE,
  LEGACY_WIKI_FIXTURE_OBSERVED_AT,
  fixtureMappingHash,
  fixtureScan,
} from "../src/import-legacy-wiki/fixture";
import { planLegacyWiki } from "../src/import-legacy-wiki/plan";
import { parseLegacyWikiMapping } from "../src/import-legacy-wiki/mapping";
import type { LegacyWikiMapping } from "../src/import-legacy-wiki/mapping";
import { renderLegacyWikiReport } from "../src/import-legacy-wiki/report";
import type { LegacyWikiReport } from "../src/import-legacy-wiki/report";
import type { ScanResult } from "../src/import-legacy-wiki/scan";

const OPTIONS = {
  observedAt: LEGACY_WIKI_FIXTURE_OBSERVED_AT,
  mappingHash: fixtureMappingHash(),
};

function plan(
  scan: ScanResult = fixtureScan(),
  mapping: LegacyWikiMapping = LEGACY_WIKI_FIXTURE.mapping,
): { events: CaptureEventInput[]; report: LegacyWikiReport } {
  return planLegacyWiki(scan, mapping, OPTIONS);
}

function candidate(event: CaptureEventInput): Record<string, unknown> {
  const raw = event.metadata[PAGE_CANDIDATE_KEY];
  if (raw === null || typeof raw !== "object") {
    throw new Error(`no candidate on ${event.source_record_id}`);
  }
  return raw as Record<string, unknown>;
}

function page(report: LegacyWikiReport, relpath: string) {
  const found = report.pages.find((entry) => entry.relpath === relpath);
  if (found === undefined) throw new Error(`no report row for ${relpath}`);
  return found;
}

describe("planLegacyWiki over the fixture wiki", () => {
  test("imports every page the mapping does not exclude, in relpath order", () => {
    const { events } = plan();
    expect(events.map((event) => event.source_record_id)).toEqual([
      "journal/2026-01-01.md",
      "notes/broken.md",
      "notes/no-frontmatter.md",
      "notes/plan.md",
      "orgs/acme.md",
      "people/ada.md",
      "people/grace.md",
      "people/linus.md",
    ]);
  });

  test("targets come from the type directory and the file stem", () => {
    const { report } = plan();
    expect(
      report.pages
        .filter((entry) => entry.outcome === "imported")
        .map((entry) => `${entry.relpath}=${entry.target}:${entry.kind}`),
    ).toEqual([
      "journal/2026-01-01.md=entities/2026-01-01:entity",
      "notes/broken.md=entities/broken:entity",
      "notes/no-frontmatter.md=entities/no-frontmatter:entity",
      "notes/plan.md=entities/plan:entity",
      "orgs/acme.md=entities/acme:entity",
      "people/ada.md=entities/ada:entity",
      "people/grace.md=entities/grace:entity",
      "people/linus.md=entities/linus:entity",
    ]);
  });

  test("sensitivity is a hint only where the mapping produced a label", () => {
    const { events } = plan();
    expect(
      events.map(
        (event) =>
          `${event.source_record_id}:${event.sensitivity_hint ?? "unlabeled"}`,
      ),
    ).toEqual([
      "journal/2026-01-01.md:unlabeled",
      "notes/broken.md:unlabeled",
      "notes/no-frontmatter.md:unlabeled",
      "notes/plan.md:unlabeled",
      "orgs/acme.md:public",
      "people/ada.md:personal",
      "people/grace.md:private",
      "people/linus.md:unlabeled",
    ]);
  });

  test("an unmapped sensitivity value is reported, never guessed", () => {
    const { report } = plan();
    expect(page(report, "journal/2026-01-01.md").sensitivity).toEqual({
      legacy: "nope",
      label: null,
      decision: "unmapped_value",
    });
    expect(page(report, "people/linus.md").sensitivity).toEqual({
      legacy: null,
      label: null,
      decision: "unlabeled",
    });
  });

  test("the whole decision record for a mapped page", () => {
    const { report } = plan();
    expect(page(report, "people/ada.md")).toEqual({
      relpath: "people/ada.md",
      outcome: "imported",
      target: "entities/ada",
      kind: "entity",
      frontmatter: { status: "parsed", problems: [] },
      type: { legacy: "Person", mapped: "person", decision: "mapped" },
      title: { source: "field" },
      sensitivity: {
        legacy: "friends",
        label: "personal",
        decision: "labeled",
      },
      occurred_at: "mtime",
      subjects: 0,
      fields: [
        { key: "title", outcome: "mapped", to: "title" },
        { key: "type", outcome: "mapped", to: "type" },
        { key: "visibility", outcome: "mapped", to: "sensitivity" },
        { key: "born", outcome: "renamed", to: "x-born" },
        { key: "aliases", outcome: "renamed", to: "x-aliases" },
        { key: "tags", outcome: "renamed", to: "x-tags" },
        { key: "updated", outcome: "renamed", to: "x-updated" },
      ],
      notes: [],
    });
  });

  test("the whole decision record for an unmapped type with a dropped field", () => {
    const { report } = plan();
    expect(page(report, "notes/plan.md")).toEqual({
      relpath: "notes/plan.md",
      outcome: "imported",
      target: "entities/plan",
      kind: "entity",
      frontmatter: { status: "parsed", problems: [] },
      type: { legacy: "Plan", mapped: "topic", decision: "unmapped_value" },
      title: { source: "field" },
      sensitivity: { legacy: null, label: null, decision: "unlabeled" },
      occurred_at: "mtime",
      subjects: 2,
      fields: [
        { key: "title", outcome: "mapped", to: "title" },
        { key: "type", outcome: "mapped", to: "type" },
        { key: "draft", outcome: "dropped", note: "by_mapping" },
        { key: "people", outcome: "mapped", to: "subjects" },
        { key: "description", outcome: "renamed", to: "x-description" },
      ],
      notes: [],
    });
  });

  test("an unparsable block still imports the page with a heading title", () => {
    const { report, events } = plan();
    expect(page(report, "notes/broken.md")).toEqual({
      relpath: "notes/broken.md",
      outcome: "imported",
      target: "entities/broken",
      kind: "entity",
      frontmatter: {
        status: "unparsed",
        problems: ["anchors are not supported"],
      },
      type: { legacy: null, mapped: "topic", decision: "defaulted" },
      title: { source: "heading" },
      sensitivity: { legacy: null, label: null, decision: "unlabeled" },
      occurred_at: "mtime",
      subjects: 0,
      fields: [],
      notes: [],
    });
    const broken = events.find((e) => e.source_record_id === "notes/broken.md");
    expect(candidate(broken as CaptureEventInput)["title"]).toBe("Broken");
  });

  test("an excluded type produces a report row and no event", () => {
    const { report } = plan();
    expect(page(report, "templates/person.md")).toEqual({
      relpath: "templates/person.md",
      outcome: "skipped",
      skip_reason: "type_excluded",
      target: null,
      kind: null,
      frontmatter: { status: "parsed", problems: [] },
      type: { legacy: "Template", mapped: null, decision: "excluded" },
      title: { source: "field" },
      sensitivity: { legacy: null, label: null, decision: "unlabeled" },
      occurred_at: "mtime",
      subjects: 0,
      fields: [
        { key: "title", outcome: "mapped", to: "title" },
        { key: "type", outcome: "mapped", to: "type" },
      ],
      notes: [],
    });
  });

  test("an ignored file is reported, not silently missing", () => {
    const { report } = plan();
    expect(page(report, "drafts/x.md")).toMatchObject({
      outcome: "skipped",
      skip_reason: "ignored",
    });
  });

  test("candidate extensions carry the mapped fields and the migration trail", () => {
    const { events } = plan();
    const ada = events.find((e) => e.source_record_id === "people/ada.md");
    expect(candidate(ada as CaptureEventInput)).toEqual({
      schema: "kizuki.page-candidate/v1",
      type: "person",
      title: "Ada",
      target: "entities/ada",
      confidence: 1,
      extensions: {
        "x-born": 1815,
        "x-aliases": ["Ada L."],
        "x-tags": ["math", "acme"],
        "x-updated": "2026-02-01",
        "x-legacy-path": "people/ada.md",
        "x-legacy-title-source": "field",
        "x-legacy-type": "Person",
        "x-legacy-sensitivity": "personal",
      },
    });
  });

  test("a nested mapping is serialized rather than dropped", () => {
    const { events, report } = plan();
    const grace = events.find((e) => e.source_record_id === "people/grace.md");
    expect(
      (
        candidate(grace as CaptureEventInput)["extensions"] as Record<
          string,
          unknown
        >
      )["x-links"],
    ).toBe('{"home":"acme","work":"navy"}');
    expect(page(report, "people/grace.md").fields).toContainEqual({
      key: "links",
      outcome: "coerced",
      to: "x-links",
      note: "json_stringified",
    });
  });

  test("confidence records how the type was decided", () => {
    const { events } = plan();
    const by = new Map(
      events.map((event) => [
        event.source_record_id,
        candidate(event)["confidence"],
      ]),
    );
    expect(by.get("people/ada.md")).toBe(1);
    expect(by.get("people/linus.md")).toBe(0.75);
    expect(by.get("notes/plan.md")).toBe(0.5);
  });

  test("occurred_at prefers a mapped date field over the file mtime", () => {
    const { events, report } = plan();
    const journal = events.find(
      (e) => e.source_record_id === "journal/2026-01-01.md",
    );
    expect(journal?.occurred_at).toBe("2026-01-01T00:00:00.000Z");
    expect(page(report, "journal/2026-01-01.md").occurred_at).toBe("field");
    expect(page(report, "people/ada.md").occurred_at).toBe("mtime");
  });

  test("subjects come only from the mapped field, wiki syntax stripped", () => {
    const { events } = plan();
    const planPage = events.find((e) => e.source_record_id === "notes/plan.md");
    expect(planPage?.subjects).toEqual([
      {
        subject_id: "legacy-wiki:ada",
        role: "about",
        display_name: "Ada",
      },
      {
        subject_id: "legacy-wiki:grace",
        role: "about",
        display_name: "Grace",
      },
    ]);
  });

  test("every event and every candidate passes the contracts", () => {
    for (const event of plan().events) {
      const validated = validateEventInput(event);
      expect(validated.ok ? [] : validated.errors).toEqual([]);
      const checked = validatePageCandidate(event.metadata);
      expect(
        checked === null ? ["absent"] : checked.ok ? [] : checked.errors,
      ).toEqual([]);
    }
  });

  test("frontmatter and the decision record travel with the evidence", () => {
    const { events } = plan();
    const ada = events.find((e) => e.source_record_id === "people/ada.md");
    expect(ada?.metadata["frontmatter_status"]).toBe("parsed");
    expect(ada?.metadata["mapping_hash"]).toBe(OPTIONS.mappingHash);
    expect(
      (ada?.metadata["frontmatter"] as Record<string, unknown>)["born"],
    ).toBe(1815);
    expect(
      (ada?.metadata["migration"] as Record<string, unknown>)["target"],
    ).toBe("entities/ada");
    expect(ada?.metadata["relpath"]).toBe("people/ada.md");
  });

  test("counts add up to the pages the report lists", () => {
    const { report } = plan();
    expect(report.counts).toMatchObject({
      files: 10,
      imported: 8,
      skipped: 2,
      labeled: 3,
      unlabeled: 6,
      unmapped_sensitivity: 1,
      type_defaulted: 4,
      type_unmapped: 1,
      frontmatter_unparsed: 1,
      scan_truncated: false,
    });
    expect(report.counts.types).toMatchObject({ person: 2, org: 1, topic: 5 });
  });
});

describe("determinism and targets", () => {
  test("two runs over equal input are deep-equal", () => {
    expect(plan()).toEqual(plan());
  });

  test("a target taken twice in one run is suffixed", () => {
    const scan: ScanResult = {
      files: [
        { relpath: "a/note.md", content: "one\n", mtimeMs: 1, size: 4 },
        { relpath: "b/note.md", content: "two\n", mtimeMs: 1, size: 4 },
        { relpath: "c/note.md", content: "three\n", mtimeMs: 1, size: 6 },
      ],
      skipped: [],
      truncated: false,
    };
    const { report } = plan(scan);
    expect(report.pages.map((entry) => entry.target)).toEqual([
      "entities/note",
      "entities/note-2",
      "entities/note-3",
    ]);
    expect(report.pages[1]?.notes).toEqual(["target_collision"]);
  });

  test("mirror mode keeps the legacy directories under the type directory", () => {
    const mapping = parseLegacyWikiMapping({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { default: "topic" },
      target: { mode: "mirror" },
    });
    const scan: ScanResult = {
      files: [
        {
          relpath: "Field Notes/2026/Plan A.md",
          content: "x\n",
          mtimeMs: 1,
          size: 2,
        },
      ],
      skipped: [],
      truncated: false,
    };
    expect(plan(scan, mapping).report.pages[0]?.target).toBe(
      "entities/field-notes/2026/plan-a",
    );
  });

  test("a mirror deeper than the page path falls back to flat", () => {
    const mapping = parseLegacyWikiMapping({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { default: "topic" },
      target: { mode: "mirror", directories: { topic: "a/b/c" } },
    });
    const scan: ScanResult = {
      files: [
        { relpath: "d/e/f/g/h/note.md", content: "x\n", mtimeMs: 1, size: 2 },
      ],
      skipped: [],
      truncated: false,
    };
    const { report } = plan(scan, mapping);
    expect(report.pages[0]?.target).toBe("a/b/c/note");
    expect(report.pages[0]?.notes).toEqual(["target: flattened"]);
  });

  test("a page body longer than the cap is truncated and the note says so", () => {
    const body = "x".repeat(300_000);
    const scan: ScanResult = {
      files: [
        {
          relpath: "big.md",
          content: `---\ntitle: Big\n---\n${body}`,
          mtimeMs: 1,
          size: body.length,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const { events, report } = plan(scan);
    expect(events[0]?.text).toHaveLength(262_144);
    expect(events[0]?.metadata["text_truncated"]).toBe(true);
    expect(report.pages[0]?.notes).toEqual(["text_truncated"]);
  });
});

describe("the report keeps page prose out", () => {
  test("no body text and no absolute path reach the JSON", () => {
    const serialized = JSON.stringify(plan().report);
    expect(serialized).not.toContain("Met at the");
    expect(serialized).not.toContain("two lines");
    expect(serialized).not.toMatch(/"\/[A-Za-z]/);
  });

  test("the rendered Markdown escapes cell separators and control characters", () => {
    const scan: ScanResult = {
      files: [
        {
          relpath: "pipe|name.md",
          content: '---\ntitle: T\n"a\u001B[31mb": 1\n---\nbody\n',
          mtimeMs: 1,
          size: 10,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const markdown = renderLegacyWikiReport(plan(scan).report);
    expect(markdown).toContain("## pipe\\|name.md");
    expect(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(markdown)).toBe(
      false,
    );
  });

  test("the rendered Markdown reports the counts table and every page", () => {
    const markdown = renderLegacyWikiReport(plan().report);
    expect(markdown).toContain("| measure | count |");
    for (const file of LEGACY_WIKI_FIXTURE.files) {
      expect(markdown).toContain(`## ${file.relpath}`);
    }
  });
});
