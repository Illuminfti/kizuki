import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { parseFrontmatter, serializePage } from "../../src/vault/frontmatter";
import type { VaultPage } from "../../src/vault/frontmatter";
import {
  ABSENT_PAGE_HASH,
  CanonWriteRefused,
  grantCanonWrite,
  hashFile,
  writePage,
} from "../../src/vault/write";
import type { CanonWriteCapability } from "../../src/vault/write";

const tempDirs: string[] = [];

function vault(): string {
  const path = mkdtempSync(join(tmpdir(), "kizuki-write-page-"));
  tempDirs.push(path);
  initVault(path);
  return path;
}

function validData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "person:ada",
    title: "Ada",
    type: "person",
    status: "active",
    sensitivity: "personal",
    taint: "clean",
    sources: ["event:01"],
    ...overrides,
  };
}

let counter = 0;
function cap(): CanonWriteCapability {
  counter += 1;
  return grantCanonWrite("loop", `receipt-${counter}`);
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("writePage", () => {
  test("refuses clobbers and archives the old content for an explicit revision", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const oldPage: VaultPage = { data: validData(), body: "Old canon.\n" };
    const newPage: VaultPage = {
      data: validData({ title: "Ada King" }),
      body: "New canon.\n",
    };
    const oldContent = serializePage(oldPage);
    const created = writePage(cap(), path, oldPage);
    expect(created.archive_path).toBeNull();
    expect(created.after_hash).toBe(hashFile(path));

    expect(() => writePage(cap(), path, newPage)).toThrow(/refusing to overwrite/i);
    expect(readFileSync(path, "utf8")).toBe(oldContent);

    const revised = writePage(cap(), path, newPage, {
      revision: true,
      expected_hash: created.after_hash,
    });

    expect(readFileSync(path, "utf8")).toBe(serializePage(newPage));
    expect(revised.after_hash).toBe(hashFile(path));
    const backups = readdirSync(join(root, "archive")).filter((name) =>
      name.includes("entities__ada.md--"),
    );
    expect(backups).toHaveLength(1);
    expect(revised.archive_path).toBe(`archive/${backups[0]}`);
    expect(revised.archive_path).toMatch(/^archive\/entities__ada\.md--receipt-\d+\.md$/);
    expect(readFileSync(join(root, revised.archive_path as string), "utf8")).toBe(oldContent);
    expect(readdirSync(join(root, "entities")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("validates before creating a file", () => {
    const root = vault();
    const path = join(root, "facts", "invalid.md");

    expect(() =>
      writePage(cap(), path, { data: { id: "fact:invalid" }, body: "No policy labels.\n" }),
    ).toThrow(/invalid page/i);
    expect(existsSync(path)).toBe(false);
  });

  test("archives a deleted page in place and preserves the prior revision", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const original: VaultPage = { data: validData(), body: "Former canon.\n" };
    const created = writePage(cap(), path, original);

    writePage(
      cap(),
      path,
      { data: validData({ status: "archived" }), body: "Former canon.\n" },
      { revision: true, expected_hash: created.after_hash },
    );

    expect(existsSync(path)).toBe(true);
    const page = parseFrontmatter(readFileSync(path, "utf8"));
    expect(page.data["status"]).toBe("archived");
    const revisions = readdirSync(join(root, "archive")).filter((name) =>
      name.includes("entities__ada.md--"),
    );
    expect(revisions).toHaveLength(1);
    expect(readFileSync(join(root, "archive", revisions[0] as string), "utf8")).toBe(
      serializePage(original),
    );
  });

  test("refuses a forged capability, even one shaped like the real thing", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const forged = Object.freeze({
      writer: "loop",
      receipt_id: "forged",
    }) as unknown as CanonWriteCapability;

    expect(() => writePage(forged, path, { data: validData(), body: "x\n" })).toThrow(
      CanonWriteRefused,
    );
    expect(existsSync(path)).toBe(false);
  });

  test("a capability is spent by its first use, even when that use failed", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const once = cap();
    writePage(once, path, { data: validData(), body: "x\n" });

    let refused: unknown;
    try {
      writePage(once, join(root, "entities", "grace.md"), { data: validData({ id: "g" }), body: "y\n" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(CanonWriteRefused);
    expect((refused as CanonWriteRefused).reason).toBe("capability_spent");
    expect(existsSync(join(root, "entities", "grace.md"))).toBe(false);

    const failing = cap();
    expect(() => writePage(failing, path, { data: {}, body: "" })).toThrow(/invalid page/i);
    expect(() => writePage(failing, path, { data: validData(), body: "z\n" })).toThrow(
      /already used/,
    );
  });

  test("a revision names the bytes it read and refuses a hand edit in between", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const created = writePage(cap(), path, { data: validData(), body: "Loop wrote this.\n" });

    expect(() =>
      writePage(cap(), path, { data: validData(), body: "No hash.\n" }, { revision: true }),
    ).toThrow(/hash/);

    writeFileSync(path, serializePage({ data: validData(), body: "Owner edited this.\n" }));
    expect(() =>
      writePage(
        cap(),
        path,
        { data: validData(), body: "Loop again.\n" },
        { revision: true, expected_hash: created.after_hash },
      ),
    ).toThrow(/changed since it was read/);
    expect(readFileSync(path, "utf8")).toContain("Owner edited this.");
    expect(readdirSync(join(root, "archive"))).toEqual([]);
  });

  test("delete archives the current bytes and removes the file", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const original: VaultPage = { data: validData(), body: "Former canon.\n" };
    const created = writePage(cap(), path, original);

    const deleted = writePage(cap(), path, original, {
      delete: true,
      expected_hash: created.after_hash,
    });
    expect(existsSync(path)).toBe(false);
    expect(deleted.after_hash).toBe(ABSENT_PAGE_HASH);
    expect(deleted.archive_path).not.toBeNull();
    expect(readFileSync(join(root, deleted.archive_path as string), "utf8")).toBe(
      serializePage(original),
    );
  });

  test("creates nested type directories and archives under the receipt id", () => {
    const root = vault();
    const path = join(root, "people", "projects", "nested.md");
    const created = writePage(cap(), path, {
      data: validData({ id: "project:nested", type: "project" }),
      body: "Nested page.\n",
    });
    expect(created.archive_path).toBeNull();
    expect(readFileSync(path, "utf8")).toContain("Nested page.");
    expect(statSync(join(root, "people", "projects")).mode & 0o777).toBe(0o700);

    const revised = writePage(
      cap(),
      path,
      { data: validData({ id: "project:nested", type: "project", title: "Nested" }), body: "Updated.\n" },
      { revision: true, expected_hash: created.after_hash },
    );
    expect(revised.archive_path).toMatch(
      /^archive\/people__projects__nested\.md--receipt-\d+\.md$/,
    );
  });

  test("two pages that share a basename keep distinct archive copies", () => {
    const root = vault();
    const first = join(root, "entities", "ada.md");
    const second = join(root, "facts", "ada.md");
    const one = writePage(cap(), first, { data: validData(), body: "Person.\n" });
    const two = writePage(cap(), second, {
      data: validData({ id: "fact:ada", type: "fact" }),
      body: "Fact.\n",
    });
    writePage(
      cap(),
      first,
      { data: validData(), body: "Person revised.\n" },
      { revision: true, expected_hash: one.after_hash },
    );
    writePage(
      cap(),
      second,
      { data: validData({ id: "fact:ada", type: "fact" }), body: "Fact revised.\n" },
      { revision: true, expected_hash: two.after_hash },
    );
    const archives = readdirSync(join(root, "archive")).sort();
    expect(archives.some((name) => name.startsWith("entities__ada.md--"))).toBe(true);
    expect(archives.some((name) => name.startsWith("facts__ada.md--"))).toBe(true);
    expect(archives).toHaveLength(2);
  });

  test("refuses to write through a symlink or to revise a missing page", () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), "kizuki-outside-"));
    tempDirs.push(outside);
    const target = join(outside, "escape.md");
    writeFileSync(target, "outside the vault\n");
    const link = join(root, "entities", "link.md");
    symlinkSync(target, link);

    expect(() => writePage(cap(), link, { data: validData(), body: "x\n" })).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("outside the vault\n");

    expect(() =>
      writePage(
        cap(),
        join(root, "entities", "missing.md"),
        { data: validData(), body: "x\n" },
        { revision: true, expected_hash: "0".repeat(64) },
      ),
    ).toThrow(/missing page/);
  });
});
