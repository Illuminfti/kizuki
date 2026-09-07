import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCanonFiles } from "../../src/vault/canon-files";
import { serializePage } from "../../src/vault/frontmatter";
import { archiveRelPath, canonStageRelPath, grantCanonWrite, hashBytes, writePage } from "../../src/vault/write";
import { tempVault } from "../helpers/vault";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const page = { data: { id: "person:item", title: "Synthetic page", type: "person", status: "active", sensitivity: "private", taint: "quoted" }, body: "Synthetic postimage.\n" };
const priorPage = { ...page, body: "Synthetic preimage.\n" };
const post = Buffer.from(serializePage(page)), prior = Buffer.from(serializePage(priorPage));
const rel = "people/item.md", id = "staged-receipt";
function fixture() {
  const vault = tempVault("staged-publication-"); cleanup.push(vault.dispose);
  mkdirSync(join(vault.path, "people"));
  return vault.path;
}

test("new live and archive publication receive a complete fsynced private creation at a separate name", () => {
  const vault = fixture(), files = openCanonFiles(vault), publish = files.publish.bind(files);
  const observed: string[] = [];
  files.publish = (stage, target) => {
    expect(stage.path).toBe(canonStageRelPath(target, observed.length === 0 ? "create" : id));
    expect(existsSync(join(vault, target))).toBe(false);
    expect(readFileSync(join(vault, stage.path))).toEqual(Buffer.from(stage.bytes));
    expect(statSync(join(vault, stage.path)).mode & 0o777).toBe(0o600);
    observed.push(target);
    return publish(stage, target);
  };
  try {
    writePage(grantCanonWrite("import", "create", vault, files), rel, priorPage);
    writePage(grantCanonWrite("correction", id, vault, files), rel, page, { revision: true, expected_hash: hashBytes(prior) });
    expect(observed).toEqual([rel, archiveRelPath(rel, id)]);
    expect(readFileSync(join(vault, rel))).toEqual(post);
    expect(readFileSync(join(vault, archiveRelPath(rel, id)))).toEqual(prior);
    expect(readdirSync(join(vault, "people"))).toEqual(["item.md"]);
    expect(readdirSync(join(vault, "archive"))).toEqual([archiveRelPath(rel, id).split("/").at(-1)!]);
  } finally { files.close(); }
});

for (const mode of ["live", "archive"] as const) {
  test(`process death in partial ${mode} stage leaves final bytes unpublished and refuses name adoption on restart`, () => {
    const vault = fixture(); if (mode === "archive") writeFileSync(join(vault, rel), prior, { mode: 0o600 });
    const target = mode === "live" ? rel : archiveRelPath(rel, id), stage = canonStageRelPath(target, id);
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      const realWrite = fs.writeSync, realSync = fs.fsyncSync;
      mock.module('node:fs', () => ({ ...fs, writeSync(fd, bytes, offset, length, position) {
        const count = realWrite(fd, bytes, offset, Math.min(length, 7), position);
        realSync(fd); process.exit(73); return count;
      } }));
      const { grantCanonWrite, writePage } = await import(${JSON.stringify(join(import.meta.dir, "../../src/vault/write.ts"))});
      writePage(grantCanonWrite('import', ${JSON.stringify(id)}, ${JSON.stringify(vault)}), ${JSON.stringify(rel)}, ${JSON.stringify(page)},
        ${JSON.stringify(mode === "archive" ? { revision: true, expected_hash: hashBytes(prior) } : {})});
    `;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15000 });
    expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 73, stderr: "" });
    expect(existsSync(join(vault, target))).toBe(mode === "archive" && target === rel);
    const residue = readFileSync(join(vault, stage)), ino = statSync(join(vault, stage)).ino;
    expect(residue).toEqual((mode === "live" ? post : prior).subarray(0, 7));
    expect(() => writePage(grantCanonWrite("import", id, vault), rel, page,
      mode === "archive" ? { revision: true, expected_hash: hashBytes(prior), recovery: true } : { recovery: true }))
      .toThrow("Refusing an existing canon stage without creation custody");
    expect(readFileSync(join(vault, stage))).toEqual(residue); expect(statSync(join(vault, stage)).ino).toBe(ino);
    if (mode === "archive") expect(readFileSync(join(vault, rel))).toEqual(prior);
    else expect(existsSync(join(vault, rel))).toBe(false);
  });
}

test("a complete unbound stage is preserved and cannot be promoted by receipt name", () => {
  const vault = fixture(), stage = canonStageRelPath(rel, id);
  writeFileSync(join(vault, stage), post, { mode: 0o600 }); const ino = statSync(join(vault, stage)).ino;
  expect(() => writePage(grantCanonWrite("import", id, vault), rel, page, { recovery: true }))
    .toThrow("Refusing an existing canon stage without creation custody");
  expect(readFileSync(join(vault, stage))).toEqual(post); expect(statSync(join(vault, stage)).ino).toBe(ino);
  expect(existsSync(join(vault, rel))).toBe(false);
});

test("archive replay reads an exact prior copy, preserves its inode and publishes the revision once", () => {
  const vault = fixture(), archive = archiveRelPath(rel, id);
  writeFileSync(join(vault, rel), prior, { mode: 0o600 });
  writeFileSync(join(vault, archive), prior, { mode: 0o600 }); const ino = statSync(join(vault, archive)).ino;
  expect(() => writePage(grantCanonWrite("import", id, vault), rel, page, { revision: true, expected_hash: hashBytes(prior) })).toThrow("Refusing to overwrite an archive copy");
  writePage(grantCanonWrite("import", id, vault), rel, page, { revision: true, expected_hash: hashBytes(prior), recovery: true });
  expect(statSync(join(vault, archive)).ino).toBe(ino); expect(readFileSync(join(vault, archive))).toEqual(prior);
  expect(readFileSync(join(vault, rel))).toEqual(post);
});

test("maximum receipt IDs retain valid archive publication within native basename limits", () => {
  const vault = fixture(), receipt = "r".repeat(128), archive = archiveRelPath(rel, receipt);
  writeFileSync(join(vault, rel), prior, { mode: 0o600 });
  expect(Buffer.byteLength(archive.split("/").at(-1)!)).toBeLessThanOrEqual(255);
  const stage = canonStageRelPath(archive, receipt);
  expect(Buffer.byteLength(stage.split("/").at(-1)!)).toBeLessThanOrEqual(255);
  writePage(grantCanonWrite("import", receipt, vault), rel, page, { revision: true, expected_hash: hashBytes(prior) });
  expect(readFileSync(join(vault, archive))).toEqual(prior); expect(readFileSync(join(vault, rel))).toEqual(post);
  expect(existsSync(join(vault, stage))).toBe(false);
});

test("exact archive plus unknown stage remains held; changed archive cannot be overwritten", () => {
  const vault = fixture(), archive = archiveRelPath(rel, id), stage = canonStageRelPath(archive, id);
  writeFileSync(join(vault, rel), prior, { mode: 0o600 });
  writeFileSync(join(vault, archive), prior, { mode: 0o600 }); writeFileSync(join(vault, stage), prior, { mode: 0o600 });
  expect(() => writePage(grantCanonWrite("import", id, vault), rel, page, { revision: true, expected_hash: hashBytes(prior), recovery: true }))
    .toThrow("Refusing an existing canon stage without creation custody");
  expect(readFileSync(join(vault, stage))).toEqual(prior);
  writeFileSync(join(vault, archive), "changed archive");
  expect(() => writePage(grantCanonWrite("import", id, vault), rel, page, { revision: true, expected_hash: hashBytes(prior), recovery: true }))
    .toThrow("Refusing a changed archive copy");
  expect(readFileSync(join(vault, rel))).toEqual(prior); expect(readFileSync(join(vault, archive), "utf8")).toBe("changed archive");
});

test("no-replace publication preserves a hostile final entry and cleans only its held creation", () => {
  const vault = fixture(), files = openCanonFiles(vault), publish = files.publish.bind(files);
  files.publish = (stage, target) => {
    writeFileSync(join(vault, target), "racing owner entry", { mode: 0o600 });
    return publish(stage, target);
  };
  try {
    expect(() => writePage(grantCanonWrite("import", id, vault, files), rel, page)).toThrow();
    expect(readFileSync(join(vault, rel), "utf8")).toBe("racing owner entry");
    expect(existsSync(join(vault, canonStageRelPath(rel, id)))).toBe(false);
  } finally { files.close(); }
});

test("changed stage inode and symlink are preserved without publication or name-based cleanup", () => {
  for (const mode of ["inode", "symlink"] as const) {
    const vault = fixture(), files = openCanonFiles(vault), publish = files.publish.bind(files);
    files.publish = (stage, target) => {
      const path = join(vault, stage.path); renameSync(path, path + ".held");
      if (mode === "symlink") symlinkSync(path + ".held", path);
      else writeFileSync(path, "racing stage entry", { mode: 0o600 });
      return publish(stage, target);
    };
    try {
      expect(() => writePage(grantCanonWrite("import", id, vault, files), rel, page)).toThrow();
      expect(existsSync(join(vault, rel))).toBe(false);
      const stage = join(vault, canonStageRelPath(rel, id));
      expect(readFileSync(stage)).toEqual(mode === "symlink" ? post : Buffer.from("racing stage entry"));
      expect(readFileSync(stage + ".held")).toEqual(post);
    } finally { files.close(); }
  }
});
