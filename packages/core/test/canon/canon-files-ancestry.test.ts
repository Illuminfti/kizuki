import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCanonFiles } from "../../src/vault/canon-files";

const roots: string[] = [];
const linux = test.if(process.platform === "linux" && process.arch === "x64" && process.geteuid?.() !== 0);
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const name of ["ancestor", "parked"]) {
      try { chmodSync(join(root, name), 0o700); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canon-files-ancestry-")); roots.push(root);
  const ancestor = join(root, "ancestor"), vault = join(ancestor, "vault");
  mkdirSync(ancestor, { mode: 0o700 }); mkdirSync(vault, { mode: 0o700 });
  chmodSync(ancestor, 0o100);
  return { root, ancestor, vault };
}

linux("uses traversal-only ancestors while retaining a readable vault for durable file operations", () => {
  const { ancestor, vault } = fixture();
  expect(() => openSync(ancestor, constants.O_RDONLY | constants.O_DIRECTORY)).toThrow(expect.objectContaining({ code: "EACCES" }));
  const files = openCanonFiles(vault);
  try {
    files.ensureDirectory("pages");
    const stage = files.create("pages/stage", Buffer.from("synthetic complete bytes"));
    const live = files.publish(stage, "pages/page.md");
    expect(readFileSync(join(vault, "pages/page.md"), "utf8")).toBe("synthetic complete bytes");
    expect(Buffer.from(files.read("pages/page.md")!.bytes).toString()).toBe("synthetic complete bytes");
    files.remove(live);
    expect(files.read("pages/page.md")).toBeNull();
  } finally { files.close(); }
});

linux("refuses symlink, mutable and unsearchable ancestry despite path-only anchors", () => {
  const { root, ancestor, vault } = fixture();
  const alias = join(root, "alias"); symlinkSync(ancestor, alias);
  expect(() => openCanonFiles(join(alias, "vault"))).toThrow();
  for (const mode of [0o122, 0o400]) {
    chmodSync(ancestor, mode);
    expect(() => openCanonFiles(vault)).toThrow();
  }
  chmodSync(ancestor, 0o100);
  chmodSync(vault, 0o100);
  expect(() => openCanonFiles(vault)).toThrow();
  chmodSync(vault, 0o700);
  const readable = openSync(vault, constants.O_RDONLY | constants.O_DIRECTORY); closeSync(readable);
});

linux("rechecks every ancestor and refuses replacement of the retained vault binding", () => {
  const { root, ancestor, vault } = fixture(), files = openCanonFiles(vault);
  try {
    files.create("page.md", Buffer.from("original bytes")).close();
    chmodSync(ancestor, 0o122);
    expect(() => files.read("page.md")).toThrow("canon_files_unsafe");
    chmodSync(ancestor, 0o100);
    renameSync(ancestor, join(root, "parked"));
    mkdirSync(ancestor, { mode: 0o700 }); mkdirSync(vault, { mode: 0o700 });
    chmodSync(ancestor, 0o100);
    expect(() => files.read("page.md")).toThrow("canon_files_changed");
    expect(readFileSync(join(root, "parked/vault/page.md"), "utf8")).toBe("original bytes");
  } finally { files.close(); }
});
