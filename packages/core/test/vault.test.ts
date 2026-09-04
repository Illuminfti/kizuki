import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCTRINE_VERSION,
  INIT_JOURNAL_SCHEMA,
  VaultInitError,
  assertVaultControl,
  doctorVault,
  findPageById,
  initVault,
  listCanonPages,
  listCanonPagesReport,
  parseFrontmatter,
  readInitJournal,
  serializePage,
  validatePage,
} from "../src/index";
import type { VaultPage } from "../src/index";

const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "kizuki-vault-"));
  tempDirs.push(path);
  return path;
}

/** Test fixtures land on disk directly; only the receipted writer may do so in product code. */
function seedPage(path: string, page: VaultPage): void {
  writeFileSync(path, serializePage(page));
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
    expect(schemaDoctrine).toContain("kizuki.doctrine/v2");
    expect(schemaDoctrine).toContain("sensitivity");
    expect(schemaDoctrine).toContain("taint");
    // The doctrine states the rule serving enforces: either label missing
    // withholds the page, not only both of them.
    expect(schemaDoctrine).toContain("a page missing\neither is never served");
    expect(schemaDoctrine).toContain("receipted");
    expect(schemaDoctrine).not.toContain("Only owner promotion writes canon.");
    expect(schemaDoctrine).not.toContain("reviewed Markdown");
    expect(schemaDoctrine).not.toContain("staging belongs");
    expect(canonDoctrine).toContain("kizuki.doctrine/v2");
    const journal = readInitJournal(vault);
    expect(journal?.schema).toBe(INIT_JOURNAL_SCHEMA);
    expect(journal?.status).toBe("ready");
    expect(journal?.doctrine_version).toBe(DOCTRINE_VERSION);

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
    initVault(vault, { adopt: true });
    writeFileSync(join(vault, ".kizuki", "x"), "derived state\n");

    const ignored = Bun.spawnSync(["git", "check-ignore", ".kizuki/x"], {
      cwd: vault,
    });

    expect(ignored.exitCode).toBe(0);
  });

  test("creates owner-only control paths even under a permissive umask", () => {
    const vault = join(tempDir(), "perms");
    const previous = process.umask(0o000);
    try {
      initVault(vault);
      expect(statSync(join(vault, ".kizuki")).mode & 0o777).toBe(0o700);
      expect(statSync(join(vault, ".kizuki", "connections")).mode & 0o777).toBe(0o700);
      expect(statSync(join(vault, ".kizuki", "receipts")).mode & 0o777).toBe(0o700);
      expect(statSync(join(vault, ".kizuki", "models")).mode & 0o777).toBe(0o700);
      expect(statSync(join(vault, ".kizuki", "exports")).mode & 0o777).toBe(0o700);
      expect(statSync(join(vault, ".kizuki", ".gitignore")).mode & 0o777).toBe(0o600);
      expect(statSync(join(vault, ".kizuki", "init.json")).mode & 0o777).toBe(0o600);
      assertVaultControl(vault);
    } finally {
      process.umask(previous);
    }
  });

  test("repairs an insecure control directory on the next init", () => {
    const vault = join(tempDir(), "repair-mode");
    initVault(vault);
    chmodSync(join(vault, ".kizuki"), 0o777);
    expect(statSync(join(vault, ".kizuki")).mode & 0o777).toBe(0o777);
    expect(() => assertVaultControl(vault)).toThrow(VaultInitError);

    const result = initVault(vault);
    expect(result.repaired).toContain(".kizuki/");
    expect(statSync(join(vault, ".kizuki")).mode & 0o777).toBe(0o700);
    assertVaultControl(vault);
  });

  test("repairs an interrupted init from the journal", () => {
    const vault = join(tempDir(), "partial");
    mkdirSync(join(vault, ".kizuki"), { recursive: true });
    writeFileSync(
      join(vault, ".kizuki", "init.json"),
      `${JSON.stringify({
        schema: INIT_JOURNAL_SCHEMA,
        status: "in_progress",
        doctrine_version: DOCTRINE_VERSION,
        adopt: null,
      })}\n`,
    );
    mkdirSync(join(vault, "entities"), { recursive: true });
    expect(existsSync(join(vault, "SCHEMA.md"))).toBe(false);

    const result = initVault(vault);
    expect(result.status).toBe("ready");
    expect(existsSync(join(vault, "SCHEMA.md"))).toBe(true);
    expect(readInitJournal(vault)?.status).toBe("ready");
    expect(readFileSync(join(vault, "CANON.md"), "utf8")).toContain("kizuki.doctrine/v2");
  });

  test("upgrades an untouched historical SCHEMA.md and leaves owner edits", () => {
    const vault = join(tempDir(), "doctrine");
    initVault(vault);
    const historical = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Only owner promotion writes canon.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
`;
    writeFileSync(join(vault, "SCHEMA.md"), historical);
    writeFileSync(join(vault, "CANON.md"), "owner-edited canon doctrine\n");
    expect(doctorVault(vault).doctrine).toEqual([
      { file: "CANON.md", state: "owner-edited" },
      { file: "SCHEMA.md", state: "upgradeable" },
    ]);

    const result = initVault(vault);
    expect(result.upgraded).toEqual(["SCHEMA.md"]);
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toContain("kizuki.doctrine/v2");
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).not.toContain("reviewed Markdown");
    expect(readFileSync(join(vault, "CANON.md"), "utf8")).toBe("owner-edited canon doctrine\n");

    const doctor = doctorVault(vault);
    expect(doctor.doctrine).toEqual([
      { file: "CANON.md", state: "owner-edited" },
      { file: "SCHEMA.md", state: "current" },
    ]);
  });

  test("refuses a non-empty directory unless adopt is set", () => {
    const vault = join(tempDir(), "notes");
    mkdirSync(vault);
    writeFileSync(join(vault, "inbox.md"), "a personal note\n");

    try {
      initVault(vault);
      throw new Error("expected adopt refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultInitError);
      expect((error as VaultInitError).code).toBe("nonempty_requires_adopt");
      expect((error as VaultInitError).inventory?.entry_count).toBe(1);
      expect((error as VaultInitError).inventory?.markdown_count).toBe(1);
    }
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);

    const dry = initVault(vault, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.status).toBe("dry-run");
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);
    expect(dry.inventory?.names).toEqual(["inbox.md"]);

    const adopted = initVault(vault, { adopt: true });
    expect(adopted.status).toBe("ready");
    expect(readInitJournal(vault)?.adopt?.policy).toBe("adopt");
    expect(readInitJournal(vault)?.adopt?.entry_count).toBe(1);
    expect(readFileSync(join(vault, "inbox.md"), "utf8")).toBe("a personal note\n");
  });

  test("refuses adopt when a reserved name is the wrong kind of entry", () => {
    const vault = join(tempDir(), "conflict");
    mkdirSync(vault);
    writeFileSync(join(vault, "entities"), "not a directory\n");

    try {
      initVault(vault, { adopt: true });
      throw new Error("expected reserved conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultInitError);
      expect((error as VaultInitError).code).toBe("reserved_conflict");
    }
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);
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
    seedPage(join(vault, "entities", "ada.md"), {
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
    expect(result.doctrine.every((item) => item.state === "current")).toBe(true);
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
    seedPage(join(vault, "entities", "ada.md"), {
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
    seedPage(join(vault, "facts", "engine.md"), {
      data: validData({ id: "fact:engine", type: "fact", title: "Engine" }),
      body: "A fact.\n",
    });

    expect(findPageById(vault, "fact:engine")?.relPath).toBe("facts/engine.md");
    expect(findPageById(vault, "fact:missing")).toBeNull();
  });

  test("skips a malformed note without aborting the vault", () => {
    const vault = tempDir();
    initVault(vault);
    seedPage(join(vault, "facts", "good.md"), {
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
