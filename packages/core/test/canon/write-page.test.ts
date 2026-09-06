import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { assertCanonFiles, openCanonFiles, type CanonFiles } from "../../src/vault/canon-files";

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
function cap(root: string): CanonWriteCapability {
  counter += 1;
  return grantCanonWrite("loop", `receipt-${counter}`, root);
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
    const created = writePage(cap(root), path, oldPage);
    expect(created.archive_path).toBeNull();
    expect(created.after_hash).toBe(hashFile(path));

    expect(() => writePage(cap(root), path, newPage)).toThrow(/refusing to overwrite/i);
    expect(readFileSync(path, "utf8")).toBe(oldContent);

    const revised = writePage(cap(root), path, newPage, {
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
      writePage(cap(root), path, { data: { id: "fact:invalid" }, body: "No policy labels.\n" }),
    ).toThrow(/invalid page/i);
    expect(existsSync(path)).toBe(false);
  });

  test("archives a deleted page in place and preserves the prior revision", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const original: VaultPage = { data: validData(), body: "Former canon.\n" };
    const created = writePage(cap(root), path, original);

    writePage(
      cap(root),
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
    const once = cap(root);
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

    const failing = cap(root);
    expect(() => writePage(failing, path, { data: {}, body: "" })).toThrow(/invalid page/i);
    expect(() => writePage(failing, path, { data: validData(), body: "z\n" })).toThrow(
      /already used/,
    );
  });

  test("a revision names the bytes it read and refuses a hand edit in between", () => {
    const root = vault();
    const path = join(root, "entities", "ada.md");
    const created = writePage(cap(root), path, { data: validData(), body: "Loop wrote this.\n" });

    expect(() =>
      writePage(cap(root), path, { data: validData(), body: "No hash.\n" }, { revision: true }),
    ).toThrow(/hash/);

    writeFileSync(path, serializePage({ data: validData(), body: "Owner edited this.\n" }));
    expect(() =>
      writePage(
        cap(root),
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
    const created = writePage(cap(root), path, original);

    const deleted = writePage(cap(root), path, original, {
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
    const created = writePage(cap(root), path, {
      data: validData({ id: "project:nested", type: "project" }),
      body: "Nested page.\n",
    });
    expect(created.archive_path).toBeNull();
    expect(readFileSync(path, "utf8")).toContain("Nested page.");
    expect(statSync(join(root, "people", "projects")).mode & 0o777).toBe(0o700);

    const revised = writePage(
      cap(root),
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
    const one = writePage(cap(root), first, { data: validData(), body: "Person.\n" });
    const two = writePage(cap(root), second, {
      data: validData({ id: "fact:ada", type: "fact" }),
      body: "Fact.\n",
    });
    writePage(
      cap(root),
      first,
      { data: validData(), body: "Person revised.\n" },
      { revision: true, expected_hash: one.after_hash },
    );
    writePage(
      cap(root),
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

    expect(() => writePage(cap(root), link, { data: validData(), body: "x\n" })).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("outside the vault\n");

    expect(() =>
      writePage(
        cap(root),
        join(root, "entities", "missing.md"),
        { data: validData(), body: "x\n" },
        { revision: true, expected_hash: "0".repeat(64) },
      ),
    ).toThrow(/missing page/);
  });

  test("writes ordinary nested doctrine and archive names while reserving only root policy paths", () => {
    const root = vault(), doctrine = readFileSync(join(root, "CANON.md"));
    const page = { data: validData(), body: "Synthetic nested canon.\n" };
    for (const rel of ["facts/CANON.md", "facts/SCHEMA.md", "facts/archive/item.md"]) {
      const created = writePage(cap(root), join(root, rel), page);
      const revised = writePage(cap(root), join(root, rel), { ...page, body: "Synthetic revision.\n" }, {
        revision: true, expected_hash: created.after_hash,
      });
      expect(readFileSync(join(root, revised.archive_path!), "utf8")).toBe(serializePage(page));
      expect(revised.archive_path).toContain(rel.replaceAll("/", "__"));
    }
    for (const rel of ["CANON.md", "SCHEMA.md", "archive/page.md", ".kizuki/page.md"]) {
      expect(() => writePage(cap(root), join(root, rel), page)).toThrow("unusable canon page path");
    }
    expect(readFileSync(join(root, "CANON.md"))).toEqual(doctrine);
    expect(existsSync(join(root, "archive/page.md"))).toBe(false);
    expect(existsSync(join(root, ".kizuki/page.md"))).toBe(false);
  });

  test("keeps a borrowed descriptor scope live while consuming each writer capability", () => {
    const root = vault(), files = openCanonFiles(root), path = join(root, "facts/borrowed.md");
    try {
      const first = grantCanonWrite("loop", "borrowed-create", root, files);
      const created = writePage(first, path, { data: validData(), body: "Synthetic first.\n" });
      expect(() => assertCanonFiles(files, root)).not.toThrow();
      const retained = files.read("facts/borrowed.md")!;
      const before = retained.bytes;
      expect(() => writePage(first, path, { data: validData(), body: "Unused.\n" })).toThrow("already used");
      const revised = writePage(grantCanonWrite("correction", "borrowed-revise", root, files), path,
        { data: validData(), body: "Synthetic revised.\n" }, { revision: true, expected_hash: created.after_hash });
      expect(retained.bytes).toEqual(before);
      expect(readFileSync(join(root, revised.archive_path!))).toEqual(Buffer.from(before));
      retained.close();
      const current = files.read("facts/borrowed.md")!;
      expect(Buffer.from(current.bytes).toString()).toContain("Synthetic revised."); current.close();
      expect(() => assertCanonFiles(files, root)).not.toThrow();
    } finally { files.close(); }
  });

  test("refuses a forged, foreign-root or closed borrowed file scope", () => {
    const root = vault(), other = vault(), files = openCanonFiles(root);
    try {
      expect(() => grantCanonWrite("loop", "foreign", other, files)).toThrow(CanonWriteRefused);
      expect(() => grantCanonWrite("loop", "forged", root, {} as CanonFiles)).toThrow(CanonWriteRefused);
      const issued = grantCanonWrite("loop", "closed-after-grant", root, files);
      files.close();
      expect(() => grantCanonWrite("loop", "closed-before-grant", root, files)).toThrow(CanonWriteRefused);
      expect(() => writePage(issued, join(root, "facts/closed.md"), { data: validData(), body: "Unused.\n" })).toThrow(CanonWriteRefused);
      expect(() => writePage(issued, join(root, "facts/closed.md"), { data: validData(), body: "Unused.\n" })).toThrow("already used");
      expect(existsSync(join(root, "facts/closed.md"))).toBe(false);
      expect(existsSync(join(other, "facts/closed.md"))).toBe(false);
    } finally { files.close(); }
  });

  test("source erasure resumes its exact same-ID private temp and never creates an archive", () => {
    const root = vault(), path = join(root, "facts/retained.md");
    const first = { data: validData(), body: "Synthetic removed evidence and independent evidence.\n" };
    const next = { data: validData(), body: "Synthetic independent evidence.\n" };
    const created = writePage(cap(root), path, first);
    const temp = join(root, "facts/.retained.md.erase-same-id.tmp");
    writeFileSync(temp, serializePage(next), { mode: 0o600 });
    const revised = writePage(grantCanonWrite("loop", "erase-same-id", root), path, next,
      { revision: true, expected_hash: created.after_hash, erase_prior: true });
    expect(revised.archive_path).toBeNull();
    expect(revised.after_hash).toBe(hashFile(path));
    expect(readFileSync(path, "utf8")).toBe(serializePage(next));
    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(join(root, "archive"))).toEqual([]);
    const removed = writePage(grantCanonWrite("loop", "erase-delete", root), path, next,
      { delete: true, expected_hash: revised.after_hash, erase_prior: true });
    expect(removed).toEqual({ archive_path: null, after_hash: ABSENT_PAGE_HASH });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, "archive"))).toEqual([]);
  });

  test("source erasure refuses changed or non-private retained temps without changing the target", () => {
    const root = vault(), path = join(root, "facts/retained.md");
    const first = { data: validData(), body: "Synthetic prior.\n" }, next = { data: validData(), body: "Synthetic postimage.\n" };
    const created = writePage(cap(root), path, first), prior = readFileSync(path);
    for (const [id, text, mode] of [
      ["changed-temp", "Different synthetic bytes", 0o600],
      ["shared-temp", serializePage(next), 0o644],
    ] as const) {
      const temp = join(root, `facts/.retained.md.${id}.tmp`);
      writeFileSync(temp, text, { mode }); chmodSync(temp, mode);
      expect(() => writePage(grantCanonWrite("loop", id, root), path, next,
        { revision: true, expected_hash: created.after_hash, erase_prior: true })).toThrow(CanonWriteRefused);
      expect(readFileSync(path)).toEqual(prior);
      expect(readFileSync(temp, "utf8")).toBe(text);
      expect(readdirSync(join(root, "archive"))).toEqual([]);
    }
  });

  test("source erasure rewrites and removes an existing archive without creating another preimage", () => {
    const root = vault(), path = join(root, "facts/archived.md");
    const first = { data: validData(), body: "Synthetic historical source and independent evidence.\n" };
    const current = { data: validData(), body: "Synthetic current page.\n" };
    const created = writePage(cap(root), path, first);
    const revision = writePage(cap(root), path, current, { revision: true, expected_hash: created.after_hash });
    const archivePath = join(root, revision.archive_path!), retained = { data: validData(), body: "Synthetic independent evidence.\n" };
    const erased = writePage(grantCanonWrite("loop", "erase-history", root), archivePath, retained,
      { revision: true, expected_hash: hashFile(archivePath), erase_prior: true });
    expect(erased.archive_path).toBeNull();
    expect(readFileSync(archivePath, "utf8")).toBe(serializePage(retained));
    expect(readdirSync(join(root, "archive"))).toHaveLength(1);
    const removed = writePage(grantCanonWrite("loop", "delete-history", root), archivePath, retained,
      { delete: true, expected_hash: erased.after_hash, erase_prior: true });
    expect(removed).toEqual({ archive_path: null, after_hash: ABSENT_PAGE_HASH });
    expect(readdirSync(join(root, "archive"))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(serializePage(current));
    expect(() => writePage(cap(root), join(root, "archive/missing.md"), retained, { erase_prior: true })).toThrow(CanonWriteRefused);
    expect(() => writePage(cap(root), join(root, "archive/missing.md"), retained,
      { revision: true, erase_prior: true, expected_hash: ABSENT_PAGE_HASH })).toThrow("missing page");
    expect(existsSync(join(root, "archive/missing.md"))).toBe(false);
  });

  test("a recovered temp token can replace only its expected target and cannot authorize deletion", () => {
    const root = vault(), files = openCanonFiles(root), first = { data: validData(), body: "Synthetic prior.\n" };
    try {
      writePage(cap(root), join(root, "facts/a.md"), first);
      writePage(cap(root), join(root, "facts/b.md"), first);
      const a = files.read("facts/a.md")!, b = files.read("facts/b.md")!, bytes = Buffer.from(serializePage({ ...first, body: "Synthetic resumed.\n" }));
      expect(files.resumeExactTemporary(a, "missing-id", bytes)).toBeNull();
      writeFileSync(join(root, "facts/.a.md.resume-id.tmp"), bytes, { mode: 0o600 });
      const resumed = files.resumeExactTemporary(a, "resume-id", bytes)!;
      expect(() => files.replace(resumed, b)).toThrow("canon_files_handle");
      expect(() => files.remove(resumed)).toThrow("canon_files_handle");
      const published = files.replace(resumed, a);
      expect(published.bytes).toEqual(Uint8Array.from(bytes)); published.close();
      expect(Buffer.from(b.bytes).toString()).toBe(serializePage(first)); b.close();
      expect(existsSync(join(root, "facts/.a.md.resume-id.tmp"))).toBe(false);
    } finally { files.close(); }
  });

  test("an ordinary revision refuses an existing temp even when its bytes match", () => {
    const root = vault(), path = join(root, "facts/ordinary.md");
    const first = { data: validData(), body: "Synthetic prior.\n" }, next = { data: validData(), body: "Synthetic postimage.\n" };
    const created = writePage(cap(root), path, first);
    const temp = join(root, "facts/.ordinary.md.ordinary-revise.tmp");
    writeFileSync(temp, serializePage(next), { mode: 0o600 });
    expect(() => writePage(grantCanonWrite("loop", "ordinary-revise", root), path, next,
      { revision: true, expected_hash: created.after_hash })).toThrow("existing temporary revision");
    expect(readFileSync(path, "utf8")).toBe(serializePage(first));
    expect(readFileSync(temp, "utf8")).toBe(serializePage(next));
  });

  test("accepts the page byte limit and refuses larger revisions before creating an archive", () => {
    const root = vault(), path = join(root, "facts/bounded.md"), data = validData();
    const headerBytes = Buffer.byteLength(serializePage({ data, body: "" }));
    const page = { data, body: "x".repeat(1_048_576 - headerBytes) };
    const created = writePage(cap(root), path, page);
    expect(statSync(path).size).toBe(1_048_576);
    expect(created.after_hash).toBe(hashFile(path));
    expect(() => writePage(cap(root), path, { data, body: page.body + "x" },
      { revision: true, expected_hash: created.after_hash })).toThrow("supported byte limit");
    expect(hashFile(path)).toBe(created.after_hash);
    expect(readdirSync(join(root, "archive"))).toEqual([]);
  });

  for (const mode of ["unsupported", "unavailable"] as const) test(`native ${mode} refuses before canon mutation and spends the capability`, () => {
    const root = vault();
    const script = `
      import {mock} from 'bun:test';
      import {strict as assert} from 'node:assert';
      const mode = ${JSON.stringify(mode)};
      if (mode === 'unsupported') Object.defineProperty(process, 'platform', {value: 'darwin'});
      else mock.module(${JSON.stringify(join(import.meta.dir, "../../src/util/owned-directory-native.ts"))}, () => ({loadOwnedDirectoryNative() {throw new Error('synthetic private detail');}}));
      const {grantCanonWrite,writePage,CanonWriteRefused} = await import(${JSON.stringify(join(import.meta.dir, "../../src/vault/write.ts"))});
      const cap = grantCanonWrite('loop', 'native-refusal', ${JSON.stringify(root)});
      const run = () => writePage(cap, ${JSON.stringify(join(root, "facts/refused.md"))}, ${JSON.stringify({ data: validData(), body: "Synthetic.\n" })});
      assert.throws(run, error => error instanceof CanonWriteRefused && error.reason === 'native_' + mode && !error.message.includes('synthetic private detail'));
      assert.throws(run, error => error instanceof CanonWriteRefused && error.reason === 'capability_spent');
      process.stdout.write('passed');
    `;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe(""); expect(child.status).toBe(0); expect(child.stdout).toBe("passed");
    expect(existsSync(join(root, "facts/refused.md"))).toBe(false);
    expect(readdirSync(join(root, "archive"))).toEqual([]);
  });
});
