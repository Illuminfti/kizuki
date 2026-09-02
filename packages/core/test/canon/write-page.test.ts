import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { parseFrontmatter, serializePage } from "../../src/vault/frontmatter";
import type { VaultPage } from "../../src/vault/frontmatter";
import {
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
    const backups = readdirSync(join(root, "archive")).filter(
      (name) => name.startsWith("ada.prev-") && name.endsWith(".md"),
    );
    expect(backups).toHaveLength(1);
    expect(revised.archive_path).toBe(`archive/${backups[0]}`);
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
      name.startsWith("ada.prev-"),
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
