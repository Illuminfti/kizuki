import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
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

/** `chmod` cannot hide a file from root, so the unreadable case is only
 *  reachable for an unprivileged user. */
const UNPRIVILEGED = process.getuid !== undefined && process.getuid() !== 0;

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
        kind: "unreadable",
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
      {
        relPath: "facts/noid.md",
        kind: "no-id",
        reason: "id: must be a non-empty string",
      },
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
        kind: "duplicate-id",
        reason: 'duplicate id "fact:dup"; first seen at facts/B.md',
      },
    ]);
    expect(findPageById(path, "fact:dup")?.body).toBe("Kept.\n");
  });

  test.skipIf(!UNPRIVILEGED)(
    "reports a file it cannot open only when the caller tolerates it",
    () => {
      const path = vault();
      writeCanon(path, "facts/kettle.md", fact(), "A copper kettle.\n");
      writeCanon(
        path,
        "facts/locked.md",
        fact({ id: "fact:locked" }),
        "Locked.\n",
      );
      chmodSync(join(path, "facts", "locked.md"), 0o000);

      // The default is fail-loud: a rebuild must not quietly omit canon.
      expect(() => listCanonPagesReport(path)).toThrow(/EACCES/);
      const report = listCanonPagesReport(path, { tolerateUnreadable: true });
      chmodSync(join(path, "facts", "locked.md"), 0o644);
      expect(report.pages.map(({ relPath }) => relPath)).toEqual([
        "facts/kettle.md",
      ]);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.relPath).toBe("facts/locked.md");
      expect(report.skipped[0]?.kind).toBe("unreadable");
      expect(report.skipped[0]?.reason).toMatch(/EACCES/);
    },
  );

  test("names why each page was skipped", () => {
    const path = vault();
    writeCanon(path, "facts/B.md", fact(), "First.\n");
    writeCanon(path, "facts/a.md", fact(), "Duplicate.\n");
    writeCanon(path, "facts/idless.md", fact({ id: 7 }), "No id.\n");
    writeFileSync(join(path, "facts", "stray.md"), "just a note\n", "utf8");

    expect(
      listCanonPagesReport(path).skipped.map(({ relPath, kind }) => [
        relPath,
        kind,
      ]),
    ).toEqual([
      ["facts/a.md", "duplicate-id"],
      ["facts/idless.md", "no-id"],
      ["facts/stray.md", "unreadable"],
    ]);
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
