import { matchesGlob } from "../legacy/coerce";
import { mappingHash } from "../legacy/mapping-file";
import type { LegacyWikiMapping } from "./mapping";
import { LEGACY_WIKI_MAPPING_SCHEMA } from "./mapping";
import type { LegacyWikiFile, ScanResult } from "./scan";

/**
 * A synthetic wiki that exercises every decision the planner can take: a
 * mapped type, a defaulted one, an excluded one, an unmapped type value, all
 * three sensitivity decisions, a nested mapping, a block scalar, a block
 * list, an absent block, an unparsable block, and an ignored directory.
 */

const MTIME = Date.UTC(2026, 1, 14, 12, 0, 0);

function file(relpath: string, content: string, offset = 0): LegacyWikiFile {
  return {
    relpath,
    content,
    mtimeMs: MTIME + offset * 1000,
    size: Buffer.byteLength(content, "utf8"),
  };
}

const MAPPING: LegacyWikiMapping = {
  schema: LEGACY_WIKI_MAPPING_SCHEMA,
  title: { field: "title" },
  type: {
    field: "type",
    values: { Person: "person", Company: "org", Template: null },
    default: "topic",
  },
  sensitivity: {
    field: "visibility",
    values: { friends: "personal", secret: "private", public: "public" },
    default: "private",
  },
  occurred_at: { field: "created", format: "date" },
  fields: { updated: "x-updated", draft: null },
  subjects: { field: "people", role: "about", namespace: "legacy-wiki" },
  target: {
    mode: "flat",
    directories: {
      person: "entities",
      org: "entities",
      project: "entities",
      place: "entities",
      topic: "entities",
      fact: "facts",
      event: "events",
      source: "sources",
      rollup: "dashboards",
    },
  },
  ignore: ["drafts/**"],
};

export const LEGACY_WIKI_FIXTURE: {
  mapping: LegacyWikiMapping;
  files: LegacyWikiFile[];
} = {
  mapping: MAPPING,
  files: [
    file(
      "people/ada.md",
      [
        "---",
        "title: Ada",
        "type: Person",
        "visibility: friends",
        "born: 1815",
        "aliases: [Ada L.]",
        "tags:",
        "  - math",
        "  - acme",
        "updated: 2026-02-01",
        "---",
        "# Ada",
        "",
        "Met at the [[acme]] library.",
        "",
      ].join("\n"),
      0,
    ),
    file(
      "people/grace.md",
      [
        "---",
        "title: Grace",
        "type: Person",
        "visibility: secret",
        "links:",
        "  home: acme",
        "  work: navy",
        "---",
        "A private page.",
        "",
      ].join("\n"),
      1,
    ),
    file(
      "people/linus.md",
      ["---", "title: Linus", "---", "No label, no type.", ""].join("\n"),
      2,
    ),
    file(
      "orgs/acme.md",
      [
        "---",
        "title: Acme",
        "type: Company",
        "visibility: public",
        "---",
        "An org page.",
        "",
      ].join("\n"),
      3,
    ),
    file(
      "notes/plan.md",
      [
        "---",
        "title: Plan",
        "type: Plan",
        "draft: true",
        "people: [Ada, Grace]",
        "description: |",
        "  two lines",
        "  of prose",
        "---",
        "A plan.",
        "",
      ].join("\n"),
      4,
    ),
    file("notes/no-frontmatter.md", "# Loose note\n\nNo block at all.\n", 5),
    file(
      "notes/broken.md",
      [
        "---",
        "&anchor",
        "title: Broken",
        "---",
        "# Broken",
        "",
        "Still text.",
        "",
      ].join("\n"),
      6,
    ),
    file(
      "journal/2026-01-01.md",
      [
        "---",
        "title: New year",
        "created: 2026-01-01",
        "visibility: nope",
        "---",
        "A journal entry.",
        "",
      ].join("\n"),
      7,
    ),
    file(
      "templates/person.md",
      [
        "---",
        "title: Person template",
        "type: Template",
        "---",
        "Scaffold.",
        "",
      ].join("\n"),
      8,
    ),
    file("drafts/x.md", "---\ntitle: Draft\n---\nIgnored.\n", 9),
  ],
};

export const LEGACY_WIKI_FIXTURE_OBSERVED_AT = "2026-03-01T00:00:00.000Z";

export function fixtureMappingHash(): string {
  return mappingHash(LEGACY_WIKI_FIXTURE.mapping);
}

/** What `scanLegacyWiki` would return for the fixture, ignore globs included. */
export function fixtureScan(): ScanResult {
  const files: LegacyWikiFile[] = [];
  const skipped: ScanResult["skipped"] = [];
  for (const entry of LEGACY_WIKI_FIXTURE.files) {
    if (
      LEGACY_WIKI_FIXTURE.mapping.ignore.some((pattern) =>
        matchesGlob(entry.relpath, pattern),
      )
    ) {
      skipped.push({ relpath: entry.relpath, reason: "ignored", kind: "file" });
      continue;
    }
    files.push(entry);
  }
  return { files, skipped, truncated: false };
}
