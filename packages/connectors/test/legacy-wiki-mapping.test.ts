import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KizukiError } from "../src/errors";
import { defaultMappingPath, loadMapping } from "../src/legacy/mapping-file";
import {
  DEFAULT_DIRECTORIES,
  LEGACY_WIKI_CONNECTOR_ID,
  LEGACY_WIKI_MAPPING_SCHEMA,
  parseLegacyWikiMapping,
} from "../src/import-legacy-wiki/mapping";

function mapping(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: LEGACY_WIKI_MAPPING_SCHEMA,
    type: { default: "topic" },
    ...overrides,
  };
}

function refusal(raw: unknown): string {
  try {
    parseLegacyWikiMapping(raw);
  } catch (error) {
    if (!(error instanceof KizukiError)) throw error;
    expect(error.code).toBe("misconfigured");
    return error.message.replace(`${LEGACY_WIKI_CONNECTOR_ID}: `, "");
  }
  throw new Error("expected the mapping to be refused");
}

describe("parseLegacyWikiMapping", () => {
  test("fills in every default around the one required decision", () => {
    expect(parseLegacyWikiMapping(mapping())).toEqual({
      schema: LEGACY_WIKI_MAPPING_SCHEMA,
      title: { field: "title" },
      type: { field: "type", values: {}, default: "topic" },
      sensitivity: { field: "sensitivity", values: {} },
      occurred_at: null,
      fields: {},
      subjects: null,
      target: { mode: "flat", directories: DEFAULT_DIRECTORIES },
      ignore: [],
    });
  });

  test("a default page type is required, and must be in the closed enum", () => {
    expect(refusal(mapping({ type: {} }))).toBe(
      "mapping.type.default: must be one of person | org | project | place | topic | event | fact | source | rollup",
    );
    expect(refusal(mapping({ type: { default: "template" } }))).toContain(
      "mapping.type.default: must be one of",
    );
  });

  test("the schema tag is checked before anything else", () => {
    expect(refusal({ type: { default: "topic" } })).toBe(
      `mapping.schema: must be "${LEGACY_WIKI_MAPPING_SCHEMA}"`,
    );
  });

  test("an unknown key is a refusal, at every depth", () => {
    expect(refusal(mapping({ foo: 1 }))).toBe("mapping: unknown key foo");
    expect(refusal(mapping({ title: { feild: "t" } }))).toBe(
      "mapping.title: unknown key feild",
    );
    expect(
      refusal(mapping({ target: { directories: { persona: "x" } } })),
    ).toBe("mapping.target.directories: unknown key persona");
  });

  test("field renames must be x-* names, distinct, and unclaimed", () => {
    expect(refusal(mapping({ fields: { created: "created" } }))).toBe(
      "mapping.fields.created: must be an x-* name or null",
    );
    expect(
      refusal(mapping({ fields: { created: "x-when", updated: "x-when" } })),
    ).toBe("mapping.fields.updated: must be distinct; x-when is taken");
    expect(refusal(mapping({ fields: { title: "x-title" } }))).toBe(
      "mapping.fields.title: already consumed by mapping.title.field",
    );
    expect(
      refusal(
        mapping({
          occurred_at: { field: "created", format: "date" },
          fields: { created: "x-created" },
        }),
      ),
    ).toBe(
      "mapping.fields.created: already consumed by mapping.occurred_at.field",
    );
  });

  test("subject namespaces are a bounded lowercase token", () => {
    expect(
      refusal(
        mapping({
          subjects: {
            field: "people",
            role: "about",
            namespace: "Legacy Wiki",
          },
        }),
      ),
    ).toBe("mapping.subjects.namespace: must match /^[a-z][a-z0-9-]{0,31}$/");
    expect(
      parseLegacyWikiMapping(
        mapping({
          subjects: {
            field: "people",
            role: "about",
            namespace: "legacy-wiki",
          },
        }),
      ).subjects,
    ).toEqual({ field: "people", role: "about", namespace: "legacy-wiki" });
  });

  test("a directory must stay inside the eight-segment page path", () => {
    expect(
      refusal(
        mapping({ target: { directories: { person: "a/b/c/d/e/f/g/h" } } }),
      ),
    ).toBe(
      "mapping.target.directories.person: must be 1..7 usable path segments",
    );
    expect(
      refusal(mapping({ target: { directories: { person: "../escape" } } })),
    ).toBe(
      "mapping.target.directories.person: must be 1..7 usable path segments",
    );
  });

  test("timestamp formats and sensitivity values are checked against the enums", () => {
    expect(
      refusal(mapping({ occurred_at: { field: "created", format: "epoch" } })),
    ).toContain("mapping.occurred_at.format: must be one of");
    expect(
      refusal(mapping({ sensitivity: { values: { secret: "top" } } })),
    ).toBe(
      "mapping.sensitivity.values.secret: must be one of public | personal | private",
    );
  });

  test("a null type value excludes the page rather than defaulting it", () => {
    expect(
      parseLegacyWikiMapping(
        mapping({ type: { default: "topic", values: { Template: null } } }),
      ).type.values,
    ).toEqual({ Template: null });
  });

  test("ignore globs must be strings", () => {
    expect(refusal(mapping({ ignore: [1] }))).toBe(
      "mapping.ignore: must be an array of glob strings",
    );
  });
});

describe("loading a mapping", () => {
  test("the default path sits beside the source", () => {
    expect(defaultMappingPath("/w/wiki", "directory")).toBe(
      "/w/wiki/kizuki-mapping.json",
    );
    expect(defaultMappingPath("/w/legacy.db", "file")).toBe(
      "/w/legacy.db.kizuki-mapping.json",
    );
  });

  test("inline and file forms hash the same, whitespace and order aside", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-mapping-"));
    try {
      const path = join(root, "kizuki-mapping.json");
      const inline = mapping({ ignore: ["drafts/**"] });
      writeFileSync(path, JSON.stringify(inline, null, 4));
      const fromFile = loadMapping(undefined, path, LEGACY_WIKI_CONNECTOR_ID);
      const fromInline = loadMapping(inline, path, LEGACY_WIKI_CONNECTOR_ID);
      expect(fromFile.hash).toBe(fromInline.hash);
      expect(fromFile.source).toBe("file");
      expect(fromInline.source).toBe("inline");

      writeFileSync(
        path,
        JSON.stringify({
          type: { default: "topic" },
          schema: inline["schema"],
          ignore: ["drafts/**"],
        }),
      );
      expect(loadMapping(undefined, path, LEGACY_WIKI_CONNECTOR_ID).hash).toBe(
        fromFile.hash,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed value changes the hash", () => {
    const a = loadMapping(mapping(), "/unused", LEGACY_WIKI_CONNECTOR_ID);
    const b = loadMapping(
      mapping({ type: { default: "fact" } }),
      "/unused",
      LEGACY_WIKI_CONNECTOR_ID,
    );
    expect(a.hash).not.toBe(b.hash);
  });

  test("a missing file names the path it looked for", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-mapping-"));
    try {
      const expected = defaultMappingPath(root, "directory");
      expect(() =>
        loadMapping(undefined, expected, LEGACY_WIKI_CONNECTOR_ID),
      ).toThrow(
        `${LEGACY_WIKI_CONNECTOR_ID}: mapping file not found: ${expected}; see docs/legacy-import.md`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed JSON is a parse error, not a crash", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-mapping-"));
    try {
      const path = join(root, "kizuki-mapping.json");
      writeFileSync(path, "{ not json");
      try {
        loadMapping(undefined, path, LEGACY_WIKI_CONNECTOR_ID);
        throw new Error("expected a refusal");
      } catch (error) {
        if (!(error instanceof KizukiError)) throw error;
        expect(error.code).toBe("parse_error");
        expect(error.message).toBe(
          `${LEGACY_WIKI_CONNECTOR_ID}: mapping file is not valid JSON: ${path}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
