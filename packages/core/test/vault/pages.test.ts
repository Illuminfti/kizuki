import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findPageById,
  listCanonPages,
  listCanonPagesReport,
} from "../../src/vault/pages";
import { tempVault, writeCanon } from "../helpers/vault";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function vault(): string {
  const created = tempVault("kizuki-pages-");
  disposers.push(created.dispose);
  return created.path;
}

function fact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "fact:kettle",
    title: "Kettle",
    type: "fact",
    status: "active",
    sensitivity: "personal",
    ...overrides,
  };
}

describe("canon page discovery", () => {
  test("listCanonPagesReport skips a note without frontmatter and reports the path", () => {
    const path = vault();
    writeCanon(path, "facts/kettle.md", fact(), "A copper kettle.\n");
    writeFileSync(join(path, "facts", "stray.md"), "just a note\n", "utf8");

    const report = listCanonPagesReport(path);

    expect(report.pages.map(({ relPath }) => relPath)).toEqual([
      "facts/kettle.md",
    ]);
    expect(report.skipped).toEqual([
      {
        relPath: "facts/stray.md",
        reason: "frontmatter must begin with an exact --- line",
      },
    ]);
  });

  test("listCanonPagesReport skips a page without a string id", () => {
    const path = vault();
    writeCanon(path, "facts/kettle.md", fact(), "A copper kettle.\n");
    writeCanon(
      path,
      "facts/noid.md",
      { title: "No id", type: "fact", status: "active", sensitivity: "public" },
      "Nothing names this page.\n",
    );

    const report = listCanonPagesReport(path);

    expect(report.pages.map(({ id }) => id)).toEqual(["fact:kettle"]);
    expect(report.skipped).toEqual([
      { relPath: "facts/noid.md", reason: "id: must be a non-empty string" },
    ]);
  });

  test("listCanonPagesReport reports a duplicate id and keeps the first file in code-point order", () => {
    const path = vault();
    // "B" sorts before "a" by code point and after it in most locales.
    writeCanon(path, "facts/B.md", fact({ id: "fact:dup" }), "Kept.\n");
    writeCanon(path, "facts/a.md", fact({ id: "fact:dup" }), "Skipped.\n");

    const report = listCanonPagesReport(path);

    expect(report.pages.map(({ relPath }) => relPath)).toEqual(["facts/B.md"]);
    expect(report.skipped).toEqual([
      {
        relPath: "facts/a.md",
        reason: 'duplicate id "fact:dup"; first seen at facts/B.md',
      },
    ]);
    expect(findPageById(path, "fact:dup")?.body).toBe("Kept.\n");
  });

  test("listCanonPages and findPageById tolerate a stray note", () => {
    const path = vault();
    writeCanon(path, "facts/kettle.md", fact(), "A copper kettle.\n");
    writeFileSync(join(path, "facts", "stray.md"), "just a note\n", "utf8");

    expect(listCanonPages(path).map(({ id }) => id)).toEqual(["fact:kettle"]);
    expect(findPageById(path, "fact:kettle")?.relPath).toBe("facts/kettle.md");
    expect(findPageById(path, "fact:missing")).toBeNull();
  });
});
