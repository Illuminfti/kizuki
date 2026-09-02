import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorVault,
  findPageById,
  initVault,
  listCanonPages,
  listCanonPagesReport,
  parseFrontmatter,
  serializePage,
  validatePage,
  writePage,
} from "../src/index";
import type { VaultPage } from "../src/index";

const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "kizuki-vault-"));
  tempDirs.push(path);
  return path;
}

function validData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "person:ada",
    title: "Ada Lovelace",
    type: "person",
    status: "active",
    sensitivity: "personal",
    sources: ["event:01", "source:notes"],
    ...overrides,
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("initVault", () => {
  test("creates the canon layout and preserves every existing doctrine file", () => {
    const vault = join(tempDir(), "canon");

    initVault(vault);

    for (const directory of [
      "entities",
      "facts",
      "events",
      "sources",
      "dashboards",
      "archive",
      ".kizuki",
    ]) {
      expect(existsSync(join(vault, directory))).toBe(true);
    }
    for (const file of ["CANON.md", "SCHEMA.md", ".gitignore", ".kizuki/.gitignore"]) {
      expect(existsSync(join(vault, file))).toBe(true);
    }
    const canonDoctrine = readFileSync(join(vault, "CANON.md"), "utf8");
    expect(canonDoctrine).toContain("kizuki audit");
    expect(canonDoctrine).toContain("kizuki undo");
    expect(canonDoctrine).toContain("kizuki tell");
    expect(canonDoctrine).not.toContain("owner-invoked");
    const schemaDoctrine = readFileSync(join(vault, "SCHEMA.md"), "utf8");
    expect(schemaDoctrine).toContain("sensitivity");
    expect(schemaDoctrine).toContain("taint");
    expect(schemaDoctrine).not.toContain("Only owner promotion writes canon.");

    const replacements = new Map([
      ["CANON.md", "owner-edited canon doctrine\n"],
      ["SCHEMA.md", "owner-edited schema doctrine\n"],
      [".gitignore", "owner-edited root ignore\n"],
      [".kizuki/.gitignore", "owner-edited database ignore\n"],
    ]);
    for (const [file, content] of replacements) {
      writeFileSync(join(vault, file), content);
    }

    initVault(vault);

    for (const [file, content] of replacements) {
      expect(readFileSync(join(vault, file), "utf8")).toBe(content);
    }
  });

  test("self-ignores the database directory in Git", () => {
    const vault = tempDir();
    const gitInit = Bun.spawnSync(["git", "init", "--quiet"], { cwd: vault });
    expect(gitInit.exitCode).toBe(0);
    initVault(vault);
    writeFileSync(join(vault, ".kizuki", "x"), "derived state\n");

    const ignored = Bun.spawnSync(["git", "check-ignore", ".kizuki/x"], {
      cwd: vault,
    });

    expect(ignored.exitCode).toBe(0);
  });
});

describe("frontmatter", () => {
  test("round-trips every supported value type without changing the body", () => {
    const page: VaultPage = {
      data: {
        id: "topic:yaml",
        title: 'Strings: "quotes", colons, and commas',
        score: -12.75,
        enabled: true,
        aliases: ["one", "two: three", 'a "quoted" alias', "comma, inside"],
      },
      body: "# Body\n\nA body with --- inside it.\n",
    };

    expect(parseFrontmatter(serializePage(page))).toEqual(page);
  });

  test("parses bare strings, numbers, booleans, and inline string arrays", () => {
    const parsed = parseFrontmatter(
      '---\ntitle: A bare value: with a colon\ncount: 3.5\nready: false\ntags: ["a", "b: c"]\n---\nBody',
    );

    expect(parsed).toEqual({
      data: {
        title: "A bare value: with a colon",
        count: 3.5,
        ready: false,
        tags: ["a", "b: c"],
      },
      body: "Body",
    });
  });
});

describe("validatePage", () => {
  test("requires all five canon identity and policy keys", () => {
    const errors = validatePage({});

    for (const key of ["id", "title", "type", "status", "sensitivity"]) {
      expect(errors.some((error) => error.includes(key))).toBe(true);
    }
  });

  test("rejects bad enums and non-string sources", () => {
    const errors = validatePage(
      validData({
        type: "document",
        status: "published",
        sensitivity: "secret",
        sources: ["event:01", 2],
      }),
    );

    for (const key of ["type", "status", "sensitivity", "sources"]) {
      expect(errors.some((error) => error.includes(key))).toBe(true);
    }
  });

  test("rejects unknown keys but preserves the x- extension namespace", () => {
    expect(validatePage(validData({ nickname: "Enchantress" }))).toContain(
      'nickname: unknown key; extensions must start with "x-"',
    );
    expect(validatePage(validData({ "x-whatever": "Enchantress" }))).toEqual([]);
  });
});

describe("doctorVault", () => {
  test("reports every canon page and counts an invalid seed", () => {
    const vault = tempDir();
    initVault(vault);
    writePage(join(vault, "entities", "ada.md"), {
      data: validData(),
      body: "# Ada\n",
    });
    writeFileSync(
      join(vault, "facts", "invalid.md"),
      serializePage({
        data: {
          id: "fact:invalid",
          title: "Missing sensitivity",
          type: "fact",
          status: "draft",
        },
        body: "Not ready.\n",
      }),
    );
    writeFileSync(
      join(vault, ".kizuki", "ignored.md"),
      "This is derived state, not canon.\n",
    );

    const result = doctorVault(vault);

    expect(result.counts).toEqual({ total: 2, valid: 1, invalid: 1 });
    expect(result.pages.map(({ page }) => page)).toEqual([
      "entities/ada.md",
      "facts/invalid.md",
    ]);
    expect(result.pages[0]?.errors).toEqual([]);
    expect(result.pages[1]?.errors.some((error) => error.includes("sensitivity"))).toBe(
      true,
    );
  });

  test("reports a markdown file that has no frontmatter and ignores archive", () => {
    const vault = tempDir();
    initVault(vault);
    writeFileSync(join(vault, "facts", "orphan.md"), "just a note\n");
    writeFileSync(
      join(vault, "archive", "stale.md"),
      serializePage({
        data: { id: "fact:stale", title: "Stale" },
        body: "Old revision.\n",
      }),
    );

    const result = doctorVault(vault);
    expect(result.counts).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(result.pages[0]?.page).toBe("facts/orphan.md");
    expect(result.pages[0]?.errors[0]).toMatch(/frontmatter/);
  });
});

describe("canon page discovery", () => {
  test("lists active canon pages and excludes control and archive files", () => {
    const vault = tempDir();
    initVault(vault);
    writePage(join(vault, "entities", "ada.md"), {
      data: validData(),
      body: "Ada body.\n",
    });
    writeFileSync(
      join(vault, ".kizuki", "ignored.md"),
      serializePage({ data: validData({ id: "ignored" }), body: "Ignored.\n" }),
    );
    writeFileSync(
      join(vault, "archive", "old.md"),
      serializePage({ data: validData({ id: "old" }), body: "Old.\n" }),
    );

    const pages = listCanonPages(vault);
    expect(pages.map((page) => page.relPath)).toEqual(["entities/ada.md"]);
    expect(pages[0]?.body).toBe("Ada body.\n");
  });

  test("finds a canon page by frontmatter id", () => {
    const vault = tempDir();
    initVault(vault);
    writePage(join(vault, "facts", "engine.md"), {
      data: validData({ id: "fact:engine", type: "fact", title: "Engine" }),
      body: "A fact.\n",
    });

    expect(findPageById(vault, "fact:engine")?.relPath).toBe("facts/engine.md");
    expect(findPageById(vault, "fact:missing")).toBeNull();
  });

  test("skips a malformed note without aborting the vault", () => {
    const vault = tempDir();
    initVault(vault);
    writePage(join(vault, "facts", "good.md"), {
      data: validData({ id: "fact:good", type: "fact", title: "Good" }),
      body: "A good note.\n",
    });
    writeFileSync(join(vault, "facts", "bad.md"), "no frontmatter here\n");

    expect(listCanonPages(vault).map((page) => page.id)).toEqual(["fact:good"]);
    expect(findPageById(vault, "fact:good")?.relPath).toBe("facts/good.md");
    expect(findPageById(vault, "fact:missing")).toBeNull();
    expect(listCanonPagesReport(vault).skipped.map(({ relPath }) => relPath)).toEqual([
      "facts/bad.md",
    ]);
  });
});

describe("writePage", () => {
  test("refuses clobbers and archives the old content for an explicit revision", () => {
    const vault = tempDir();
    initVault(vault);
    const path = join(vault, "entities", "ada.md");
    const oldPage: VaultPage = { data: validData(), body: "Old canon.\n" };
    const newPage: VaultPage = {
      data: validData({ title: "Ada King, Countess of Lovelace" }),
      body: "New canon.\n",
    };
    const oldContent = serializePage(oldPage);
    writePage(path, oldPage);

    expect(() => writePage(path, newPage)).toThrow(/refusing to overwrite/i);
    expect(readFileSync(path, "utf8")).toBe(oldContent);

    writePage(path, newPage, { revision: true });

    expect(readFileSync(path, "utf8")).toBe(serializePage(newPage));
    const backups = readdirSync(join(vault, "archive")).filter(
      (name) => name.startsWith("ada.prev-") && name.endsWith(".md"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(vault, "archive", backups[0] as string), "utf8")).toBe(
      oldContent,
    );
  });

  test("validates before creating a file", () => {
    const vault = tempDir();
    initVault(vault);
    const path = join(vault, "facts", "invalid.md");

    expect(() =>
      writePage(path, {
        data: { id: "fact:invalid" },
        body: "No policy labels.\n",
      }),
    ).toThrow(/invalid page/i);
    expect(existsSync(path)).toBe(false);
  });

  test("archives a deleted page in place and preserves the prior revision", () => {
    const vault = tempDir();
    initVault(vault);
    const path = join(vault, "entities", "ada.md");
    const original = { data: validData(), body: "Former canon.\n" };
    writePage(path, original);

    // Reconciliation rule 4 keeps the archived page at its canon path.
    writePage(
      path,
      { data: validData({ status: "archived" }), body: "Former canon.\n" },
      { revision: true },
    );

    expect(existsSync(path)).toBe(true);
    const page = parseFrontmatter(readFileSync(path, "utf8"));
    expect(page.data["status"]).toBe("archived");
    expect(page.body).toBe("Former canon.\n");
    const revisions = readdirSync(join(vault, "archive")).filter((name) =>
      name.startsWith("ada.prev-"),
    );
    expect(revisions).toHaveLength(1);
    expect(readFileSync(join(vault, "archive", revisions[0] as string), "utf8")).toBe(
      serializePage(original),
    );
  });
});
