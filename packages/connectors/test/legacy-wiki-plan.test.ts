import { describe, expect, test } from "bun:test";
import {
  PAGE_CANDIDATE_KEY,
  targetProblem,
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
import {
  DEFAULT_DIRECTORIES,
  parseLegacyWikiMapping,
} from "../src/import-legacy-wiki/mapping";
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

  test("every page carries a label; an unread one is the connector default", () => {
    const { events } = plan();
    expect(
      events.map(
        (event) => `${event.source_record_id}:${event.sensitivity_hint}`,
      ),
    ).toEqual([
      "journal/2026-01-01.md:private",
      "notes/broken.md:private",
      "notes/no-frontmatter.md:private",
      "notes/plan.md:private",
      "orgs/acme.md:personal",
      "people/ada.md:personal",
      "people/grace.md:private",
      "people/linus.md:private",
    ]);
  });

  test("a legacy value the mapping names is used, sentinel-shaped or not", () => {
    const mapping = parseLegacyWikiMapping({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { field: "type", values: { unusable: "fact" }, default: "topic" },
      sensitivity: { field: "visibility", values: { unusable: "private" } },
    });
    const scan: ScanResult = {
      files: [
        {
          relpath: "named.md",
          content: "---\ntype: unusable\nvisibility: unusable\n---\nbody\n",
          mtimeMs: 1,
          size: 40,
        },
        {
          // A boolean is not a vocabulary term: `true` is not a type name,
          // and stringifying it would invent one the mapping never saw.
          relpath: "boolean.md",
          content: "---\ntype: true\n---\nbody\n",
          mtimeMs: 1,
          size: 26,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const { report } = planLegacyWiki(scan, mapping, OPTIONS);
    expect(page(report, "named.md").type).toEqual({
      legacy: "unusable",
      mapped: "fact",
      decision: "mapped",
    });
    expect(page(report, "named.md").sensitivity).toEqual({
      legacy: "unusable",
      label: "private",
      decision: "labeled",
    });
    expect(page(report, "boolean.md").type).toEqual({
      legacy: null,
      mapped: "topic",
      decision: "defaulted",
    });
    expect(page(report, "boolean.md").fields).toContainEqual({
      key: "type",
      outcome: "dropped",
      to: "type",
      note: "unusable",
    });
  });

  test("an mtime outside the ledger's grammar still imports the page", () => {
    const scan: ScanResult = {
      files: [
        {
          relpath: "far.md",
          content: "body\n",
          // A 64-bit filesystem timestamp: `Date` renders it with a signed
          // six-digit year the ledger refuses, and one refused event would
          // hold the cursor — and therefore every later sync — back forever.
          mtimeMs: 400_000_000_000_000,
          size: 5,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const { events, report } = plan(scan);
    expect(validateEventInput(events[0]).ok).toBe(true);
    expect(events[0]?.occurred_at).toBe(OPTIONS.observedAt);
    expect(page(report, "far.md").occurred_at).toBe("observed");
    expect(page(report, "far.md").notes).toEqual(["occurred_at: unusable_mtime"]);
  });

  test("a page the estate published is raised to the connector floor", () => {
    const { report } = plan();
    // The wiki said `public`; a local estate's floor is `personal`, so the
    // label the estate wrote is recorded and the served label is raised.
    expect(page(report, "orgs/acme.md").sensitivity).toEqual({
      legacy: "public",
      label: "personal",
      decision: "labeled",
    });
    expect(page(report, "orgs/acme.md").notes).toEqual([
      "sensitivity: raised_to_floor",
    ]);
    expect(report.counts.sensitivity_raised).toBe(1);
  });

  test("a label the mapping cannot read resolves to private, not the default", () => {
    const wide: LegacyWikiMapping = {
      ...LEGACY_WIKI_FIXTURE.mapping,
      sensitivity: {
        ...LEGACY_WIKI_FIXTURE.mapping.sensitivity,
        default: "public",
      },
    };
    const scan: ScanResult = {
      files: [
        {
          relpath: "unmapped.md",
          content: "---\nvisibility: totally-secret\n---\nbody\n",
          mtimeMs: 1,
          size: 40,
        },
        {
          relpath: "unparsed.md",
          content: "---\nvisibility: &anchor\n---\nbody\n",
          mtimeMs: 1,
          size: 34,
        },
        { relpath: "absent.md", content: "no frontmatter\n", mtimeMs: 1, size: 15 },
      ],
      skipped: [],
      truncated: false,
    };
    const { events, report } = planLegacyWiki(scan, wide, OPTIONS);
    expect(
      events.map((e) => `${e.source_record_id}:${e.sensitivity_hint}`),
    ).toEqual([
      // Nothing the mapping could not read is published, whatever the
      // connector default says; an estate that really carried no label takes
      // the default, raised to the floor.
      "absent.md:personal",
      "unmapped.md:private",
      "unparsed.md:private",
    ]);
    expect(page(report, "unparsed.md").sensitivity.decision).toBe("unreadable");
    expect(page(report, "unmapped.md").sensitivity.decision).toBe(
      "unmapped_value",
    );
    expect(page(report, "absent.md").sensitivity.decision).toBe("unlabeled");
    expect(report.counts.unreadable_sensitivity).toBe(1);
  });

  test("a defaulted label says so, and never claims the estate wrote it", () => {
    const { report, events } = plan();
    expect(page(report, "journal/2026-01-01.md").sensitivity).toEqual({
      legacy: "nope",
      label: "private",
      decision: "unmapped_value",
    });
    expect(page(report, "people/linus.md").sensitivity).toEqual({
      legacy: null,
      label: "private",
      decision: "unlabeled",
    });
    const linus = events.find((e) => e.source_record_id === "people/linus.md");
    expect(
      candidate(linus as CaptureEventInput)["x-legacy-sensitivity"],
    ).toBeUndefined();
  });

  test("a mapping may widen the default it applies", () => {
    const { events } = plan(fixtureScan(), {
      ...LEGACY_WIKI_FIXTURE.mapping,
      sensitivity: {
        ...LEGACY_WIKI_FIXTURE.mapping.sensitivity,
        default: "personal",
      },
    });
    const linus = events.find((e) => e.source_record_id === "people/linus.md");
    expect(linus?.sensitivity_hint).toBe("personal");
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
      sensitivity: { legacy: null, label: "private", decision: "unlabeled" },
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
      sensitivity: { legacy: null, label: "private", decision: "unreadable" },
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
      sensitivity: { legacy: null, label: "private", decision: "unlabeled" },
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
      unlabeled: 3,
      unmapped_sensitivity: 1,
      unreadable_sensitivity: 1,
      sensitivity_raised: 1,
      type_defaulted: 4,
      type_unmapped: 1,
      frontmatter_unparsed: 1,
      scan_truncated: false,
    });
    expect(report.counts.types).toMatchObject({ person: 2, org: 1, topic: 5 });
  });

  test("the label counts size the import, not the whole directory", () => {
    const { counts } = plan().report;
    // A page the walk skipped and a page the mapping excluded have no label to
    // decide, so counting them as unlabeled would overstate the job.
    expect(
      counts.labeled +
        counts.unlabeled +
        counts.unmapped_sensitivity +
        counts.unreadable_sensitivity,
    ).toBe(counts.imported);
    expect(counts.imported + counts.skipped).toBe(counts.files);
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

  test("a pinned page carries the decision a full run would have made", () => {
    const scan: ScanResult = {
      files: [
        { relpath: "a/note.md", content: "one\n", mtimeMs: 1, size: 4 },
        { relpath: "b/note.md", content: "two\n", mtimeMs: 1, size: 4 },
      ],
      skipped: [],
      truncated: false,
    };
    const full = planLegacyWiki(scan, LEGACY_WIKI_FIXTURE.mapping, OPTIONS);
    // What a sync does when only the second page changed: the other page is
    // not re-emitted, and this one keeps the target it was staged at.
    const resumed = planLegacyWiki(
      { ...scan, files: [scan.files[1] as ScanResult["files"][number]] },
      LEGACY_WIKI_FIXTURE.mapping,
      {
        ...OPTIONS,
        pinned: { "a/note.md": "entities/note", "b/note.md": "entities/note-2" },
      },
    );
    const before = full.events.find((e) => e.source_record_id === "b/note.md");
    const after = resumed.events.find(
      (e) => e.source_record_id === "b/note.md",
    );
    // Byte-identical page, byte-identical decision record: the ledger dedupes
    // on a hash that covers the metadata, so a note that depended on which
    // run emitted the page would file the same page twice.
    expect(after).toEqual(before);
    expect(page(resumed.report, "b/note.md").notes).toEqual([
      "target_collision",
    ]);
  });

  test("an estate that slugs to one leaf still plans in linear time", () => {
    // Every name here slugs to the same leaf, which is the ordinary case for
    // an estate written in a non-Latin script. Rescanning the suffixes from
    // 2 for each page made the walk's advertised 50 000 files unreachable.
    const files = Array.from({ length: 3000 }, (_, i) => ({
      relpath: `dir${i}/\u30da\u30fc\u30b8.md`,
      content: "body\n",
      mtimeMs: 1,
      size: 5,
    }));
    const started = Bun.nanoseconds();
    const { report } = plan({ files, skipped: [], truncated: false });
    const elapsed = (Bun.nanoseconds() - started) / 1e6;
    const targets = new Set(report.pages.map((entry) => entry.target));
    expect(targets.size).toBe(3000);
    expect(report.pages[2999]?.target).toBe("entities/page-3000");
    // Quadratic resolution took well over a second for this many pages.
    expect(elapsed).toBeLessThan(1000);
  });

  test("a collision between two maximum-length leaves still terminates", () => {
    // Both stems slug to the same 64-character leaf, so appending the suffix
    // before slugging truncates it straight back off: the search for a free
    // name would never end.
    const long = "a".repeat(70);
    const scan: ScanResult = {
      files: [
        { relpath: `one/${long}.md`, content: "one\n", mtimeMs: 1, size: 4 },
        { relpath: `two/${long}.md`, content: "two\n", mtimeMs: 1, size: 4 },
        { relpath: `six/${long}.md`, content: "six\n", mtimeMs: 1, size: 4 },
      ],
      skipped: [],
      truncated: false,
    };
    const targets = plan(scan).report.pages.map((entry) => entry.target);
    expect(new Set(targets).size).toBe(3);
    for (const target of targets) {
      expect(typeof target).toBe("string");
      expect(targetProblem(target as string)).toBeNull();
    }
    expect(targets[1]).toBe(`entities/${"a".repeat(62)}-2`);
    expect(targets[2]).toBe(`entities/${"a".repeat(62)}-3`);
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

  test("a raw vocabulary value is capped in every rendering", () => {
    const value = `VOCAB${"z".repeat(5000)}`;
    const scan: ScanResult = {
      files: [
        {
          relpath: "a.md",
          content: `---\ntype: "${value}"\nvisibility: "${value}"\n---\nbody\n`,
          mtimeMs: 1,
          size: 10,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const { report } = plan(scan);
    const entry = page(report, "a.md");
    expect(entry.type.legacy).toBe(value.slice(0, 64));
    expect(entry.sensitivity.legacy).toBe(value.slice(0, 64));
    // report-file.ts stringifies the document verbatim, so the cap has to hold
    // in the document itself and not only in the Markdown renderer.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("z".repeat(65));
    expect(renderLegacyWikiReport(report)).not.toContain("z".repeat(65));
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
    expect(
      /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(markdown),
    ).toBe(false);
  });

  test("the rendered Markdown reports the counts table and every page", () => {
    const markdown = renderLegacyWikiReport(plan().report);
    expect(markdown).toContain("| measure | count |");
    for (const file of LEGACY_WIKI_FIXTURE.files) {
      expect(markdown).toContain(`## ${file.relpath}`);
    }
  });
});

describe("a legacy value named after an Object member", () => {
  const MEMBERS = [
    "toString",
    "valueOf",
    "constructor",
    "hasOwnProperty",
    "__proto__",
  ];

  function pageWith(value: string): ScanResult {
    return {
      files: [
        {
          relpath: "a.md",
          content: `---\ntitle: A\ntype: ${value}\nvisibility: ${value}\n---\nbody\n`,
          mtimeMs: 1,
          size: 20,
        },
      ],
      skipped: [],
      truncated: false,
    };
  }

  test("is never mapped through the prototype chain", () => {
    for (const member of MEMBERS) {
      const { events, report } = plan(pageWith(member));
      const entry = page(report, "a.md");
      expect(entry.sensitivity).toEqual({
        legacy: member,
        label: "private",
        decision: "unmapped_value",
      });
      expect(entry.type.mapped).toBe("topic");
      expect(entry.type.decision).toBe("unmapped_value");
      expect(events[0]?.sensitivity_hint).toBe("private");
      expect(validateEventInput(events[0] as CaptureEventInput).ok).toBe(true);
    }
  });

  test("counts the page as unlabeled, not as labeled", () => {
    const { report } = plan(pageWith("toString"));
    expect(report.counts.labeled).toBe(0);
    expect(report.counts.unmapped_sensitivity).toBe(1);
  });

  test("a mapping file that really maps __proto__ still applies it", () => {
    // JSON.parse, not a literal: a literal would set the prototype instead.
    const mapping = parseLegacyWikiMapping(
      JSON.parse(`{
        "schema": "kizuki.legacy-wiki-mapping/v1",
        "type": { "values": { "__proto__": "person" }, "default": "topic" },
        "sensitivity": { "field": "visibility", "values": { "__proto__": "private" } }
      }`) as unknown,
    );
    const { events, report } = plan(pageWith("__proto__"), mapping);
    expect(page(report, "a.md").type.mapped).toBe("person");
    expect(events[0]?.sensitivity_hint).toBe("private");
  });
});

describe("the candidate the floor will actually accept", () => {
  function pageWithKeys(frontmatter: string): ScanResult {
    return {
      files: [
        {
          relpath: "a.md",
          content: `---\ntitle: A\n${frontmatter}\n---\nbody\n`,
          mtimeMs: 1,
          size: 20,
        },
      ],
      skipped: [],
      truncated: false,
    };
  }

  test("a legacy key with a dot mints a name core's grammar allows", () => {
    const { events, report } = plan(pageWithKeys("date.created: 2026-01-01"));
    const extensions = candidate(events[0] as CaptureEventInput)[
      "extensions"
    ] as Record<string, unknown>;
    expect(Object.keys(extensions)).toContain("x-date-created");
    expect(page(report, "a.md").fields).toContainEqual({
      key: "date.created",
      outcome: "renamed",
      to: "x-date-created",
    });
    const checked = validatePageCandidate(
      (events[0] as CaptureEventInput).metadata,
    );
    expect(checked !== null && checked.ok).toBe(true);
  });

  test("a page cannot overwrite a name the importer or the floor sets", () => {
    const { events, report } = plan(
      pageWithKeys(
        'x-legacy-path: "/elsewhere"\nx-legacy-title-source: heading\nx-connector: kizuki.trustworthy',
      ),
    );
    const extensions = candidate(events[0] as CaptureEventInput)[
      "extensions"
    ] as Record<string, unknown>;
    expect(extensions["x-legacy-path"]).toBe("a.md");
    expect(extensions["x-legacy-title-source"]).toBe("field");
    expect(extensions["x-connector"]).toBeUndefined();
    for (const key of [
      "x-legacy-path",
      "x-legacy-title-source",
      "x-connector",
    ]) {
      expect(page(report, "a.md").fields).toContainEqual({
        key,
        outcome: "dropped",
        to: key,
        note: "name_conflict",
      });
    }
  });

  test("keys that differ only outside the grammar collide, once", () => {
    const { report } = plan(pageWithKeys("date.created: 1\ndate-created: 2"));
    const outcomes = page(report, "a.md").fields.map(
      (field) => `${field.key}:${field.outcome}`,
    );
    expect(outcomes).toContain("date-created:dropped");
  });

  test("an astral title survives to a candidate the floor accepts", () => {
    const emoji = "\u{1F600}".repeat(150);
    const scan: ScanResult = {
      files: [
        {
          relpath: "a.md",
          content: `---\ntitle: "${emoji}"\nnote: "${emoji}"\n---\nbody\n`,
          mtimeMs: 1,
          size: 20,
        },
      ],
      skipped: [],
      truncated: false,
    };
    const { events, report } = plan(scan);
    expect(page(report, "a.md").notes).not.toContain("candidate_rejected");
    expect(candidate(events[0] as CaptureEventInput)["title"]).toBe(emoji);
    const checked = validatePageCandidate(
      (events[0] as CaptureEventInput).metadata,
    );
    expect(checked !== null && checked.ok).toBe(true);
  });

  test("a candidate the floor would refuse is reported, not emitted", () => {
    // A directory past the segment limit can only come from a mapping that
    // never went through the parser, which is exactly the case where a silent
    // downgrade to a capture note would be hardest to explain.
    const mapping: LegacyWikiMapping = {
      ...LEGACY_WIKI_FIXTURE.mapping,
      target: {
        mode: "flat",
        directories: { ...DEFAULT_DIRECTORIES, topic: "x".repeat(65) },
      },
    };
    const { events, report } = plan(pageWithKeys("note: kept"), mapping);
    const entry = page(report, "a.md");
    expect(entry.outcome).toBe("imported");
    expect(entry.target).toBeNull();
    expect(entry.kind).toBeNull();
    expect(entry.notes).toContain("candidate_rejected");
    expect(events).toHaveLength(1);
    expect(PAGE_CANDIDATE_KEY in (events[0] as CaptureEventInput).metadata).toBe(
      false,
    );
    expect(validatePageCandidate((events[0] as CaptureEventInput).metadata)).toBe(
      null,
    );
  });
});
