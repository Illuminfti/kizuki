import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { undoReceipt } from "../src/canon/undo";
import { exportVault, restoreVault, type ExportManifest } from "../src/export";
import { openLedger } from "../src/ledger/db";
import { serializePage } from "../src/vault/frontmatter";
import { initVault } from "../src/vault/init";
import { MAX_CANON_PAGE_BYTES } from "../src/vault/pages";
import { canonFixture, putEvent, storeClaim, write } from "./canon/helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-inventory-"));
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(":memory:");
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, vault, db, backup: join(root, "backup"), target: join(root, "restored") };
}

function putPage(vault: string, path: string, id: string, status = "active"): string {
  const bytes = serializePage({
    data: { id, title: id, type: "fact", status, sensitivity: "personal", taint: "clean" },
    body: `A synthetic note about ${id}.\n`,
  });
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), bytes);
  return bytes;
}

function inventory(backup: string) {
  return JSON.parse(readFileSync(join(backup, "export-inventory.json"), "utf8")) as {
    schema: string;
    files: { path: string; kind: string; sha256: string; size: number }[];
    excluded_entries: { hidden: number; links_or_special: number; backup_containers: number; unclassified: number };
    unavailable_archive_references: number;
    recovery_limits: string[];
  };
}

function omitDeclaration(backup: string, manifest: ExportManifest, path: string): void {
  const { manifest_sha256: _digest, ...unsigned } = manifest;
  const files = { ...unsigned.files };
  delete files[path];
  const next = { ...unsigned, files };
  const signed = { ...next, manifest_sha256: new Bun.CryptoHasher("sha256")
    .update(`${JSON.stringify(next, null, 2)}\n`).digest("hex") };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`);
}

describe("classified export inventory", () => {
  test("preserves doctrine and all canon statuses in supported custom and Unicode paths", () => {
    const { db, vault, backup, target } = fixture();
    const pages = [
      ["captures/note.md", "capture", "active"],
      ["facts/CANON.md", "nested-canon-name", "active"],
      ["facts/SCHEMA.md", "nested-schema-name", "draft"],
      ["people/Ada.md", "ada", "draft"],
      ["projects/older.md", "old", "archived"],
      ["projects/a.kizuki-backup-topic/note.md", "ordinary-backup-name", "active"],
      ["projects/archive/note.md", "nested-archive-canon", "active"],
      ["topics/ä note.md", "unicode", "active"],
    ] as const;
    const expected = pages.map(([path, id, status]) => [path, putPage(vault, path, id, status)] as const);
    writeFileSync(join(vault, "CANON.md"), "# Owner doctrine\nKeep my exact words.\n");
    writeFileSync(join(vault, "SCHEMA.md"), "# Owner schema\nPreserve these exact rules.\n");
    const manifest = exportVault(db, vault, backup);
    const listing = inventory(backup);
    expect(manifest.schema).toBe("kizuki.backup/v3");
    expect(listing.schema).toBe("kizuki.export-inventory/v1");
    expect(listing.files.map(file => file.path)).toEqual([
      "CANON.md", "SCHEMA.md", "captures/note.md", "facts/CANON.md", "facts/SCHEMA.md", "people/Ada.md",
      "projects/a.kizuki-backup-topic/note.md", "projects/archive/note.md", "projects/older.md", "topics/ä note.md",
    ]);
    for (const item of listing.files) expect(manifest.files[`vault/${item.path}`]).toMatchObject({ sha256: item.sha256, size: item.size });
    restoreVault(backup, target);
    for (const [path, bytes] of expected) expect(readFileSync(join(target, path), "utf8")).toBe(bytes);
    expect(readFileSync(join(target, "CANON.md"), "utf8")).toBe("# Owner doctrine\nKeep my exact words.\n");
    expect(readFileSync(join(target, "SCHEMA.md"), "utf8")).toBe("# Owner schema\nPreserve these exact rules.\n");
    expect(listing.files.find(file => file.path === "projects/archive/note.md")?.kind).toBe("canon");
    expect(listing.recovery_limits.join(" ")).toContain("does not assert complete runtime recovery");
  });

  test("excludes hidden, Git, unrelated, link and previous-backup entries before selecting canon", () => {
    const { db, vault, backup } = fixture();
    putPage(vault, "facts/kept.md", "kept");
    putPage(vault, ".git/hidden.md", "git-data");
    putPage(vault, ".hidden/note.md", "hidden-data");
    putPage(vault, "archive/unrelated.md", "unrelated-root-archive");
    putPage(vault, "old-export/vault/facts/copy.md", "old-copy");
    writeFileSync(join(vault, "old-export", "manifest.json"), JSON.stringify({ schema: "kizuki.backup/v3" }));
    writeFileSync(join(vault, "notes.txt"), "unrelated synthetic data\n");
    writeFileSync(join(vault, "README.md"), "# An unrelated document\n");
    symlinkSync(join(vault, "facts", "kept.md"), join(vault, "facts", "linked.md"));
    const manifest = exportVault(db, vault, backup);
    expect(Object.keys(manifest.files).filter(path => path.startsWith("vault/"))).toEqual([
      "vault/CANON.md", "vault/SCHEMA.md", "vault/facts/kept.md",
    ]);
    expect(inventory(backup).excluded_entries).toMatchObject({ backup_containers: 1, links_or_special: 1, unclassified: 3 });
    expect(inventory(backup).excluded_entries.hidden).toBeGreaterThanOrEqual(3);
  });

  for (const doctrine of ["CANON.md", "SCHEMA.md"]) {
    for (const state of ["missing", "symlink", "directory", "fifo"]) {
      test(`refuses ${state} ${doctrine} before publishing an incomplete doctrine set`, () => {
        const { db, root, vault, backup } = fixture();
        const path = join(vault, doctrine);
        rmSync(path);
        if (state === "symlink") {
          const other = join(root, "owned-doctrine.md");
          writeFileSync(other, "# Benign owned fixture\n");
          symlinkSync(other, path);
        } else if (state === "directory") {
          mkdirSync(path);
        } else if (state === "fifo") {
          const made = Bun.spawnSync(["mkfifo", path]);
          if (made.exitCode !== 0) throw new Error("could not create synthetic FIFO fixture");
        }
        expect(() => exportVault(db, vault, backup)).toThrow("requires regular root doctrine files");
        expect(existsSync(backup)).toBe(false);
      });
    }
  }

  test("refuses a candidate hardlinked to another owned fixture file", () => {
    const { db, root, vault, backup } = fixture();
    putPage(root, "owned-note.md", "owned-note");
    linkSync(join(root, "owned-note.md"), join(vault, "facts", "linked-note.md"));
    expect(() => exportVault(db, vault, backup)).toThrow("regular and singly linked");
    expect(existsSync(backup)).toBe(false);
  });

  test("rechecks the selected file link count when copying begins", () => {
    const { db, root, vault, backup } = fixture();
    putPage(vault, "facts/note.md", "owned-note");
    expect(() => exportVault(db, vault, backup, { onProgress(label) {
      if (label === "inventory") linkSync(join(vault, "facts", "note.md"), join(root, "owned-note-link.md"));
    } })).toThrow("regular and singly linked");
    expect(existsSync(backup)).toBe(false);
  });

  test("writes the full hashed inventory before its first payload copy", () => {
    const { db, root, vault, backup } = fixture();
    putPage(vault, "facts/first.md", "first");
    let observed = false;
    exportVault(db, vault, backup, { onProgress(label) {
      if (label !== "inventory") return;
      const name = readdirSync(root).find(entry => entry.includes(".kizuki-backup-"));
      if (name === undefined) throw new Error("expected private export staging");
      const staged = join(root, name);
      expect(inventory(staged).files).toHaveLength(3);
      expect(existsSync(join(staged, "vault"))).toBe(false);
      observed = true;
    } });
    expect(observed).toBe(true);
  });

  test("refuses a changed selected file without publishing the backup", () => {
    const { db, vault, backup } = fixture();
    putPage(vault, "facts/first.md", "first");
    expect(() => exportVault(db, vault, backup, { onProgress(label) {
      if (label === "inventory") putPage(vault, "facts/first.md", "updated");
    } })).toThrow("inventory file changed");
    expect(existsSync(backup)).toBe(false);
  });

  test("refuses incomplete canon classification instead of publishing a partial page set", () => {
    const { db, vault, backup } = fixture();
    putPage(vault, "facts/one.md", "same-id");
    putPage(vault, "facts/two.md", "same-id");
    expect(() => exportVault(db, vault, backup)).toThrow("duplicate page identity");
    expect(existsSync(backup)).toBe(false);
  });

  test("bounds candidate page bytes before parsing them", () => {
    const { db, vault, backup } = fixture();
    writeFileSync(join(vault, "facts", "oversize.md"), Buffer.alloc(MAX_CANON_PAGE_BYTES + 1, 32));
    expect(() => exportVault(db, vault, backup)).toThrow("file exceeds its bound");
    expect(existsSync(backup)).toBe(false);
  });

  for (const legacy of [false, true]) {
    test(`preserves ${legacy ? "legacy-named" : "current"} receipt archives and exact-byte undo`, async () => {
      const ctx = canonFixture();
      disposers.push(ctx.dispose);
      const parent = mkdtempSync(join(tmpdir(), "kizuki-export-undo-"));
      disposers.push(() => rmSync(parent, { recursive: true, force: true }));
      const event = putEvent(ctx.db);
      const created = write(ctx.io, await storeClaim(ctx.db, event));
      const prior = readFileSync(join(ctx.vault, created.page_path));
      const edited = write(ctx.io, await storeClaim(ctx.db, event, {
        kind: "edit", predicate: null, object: null, body: "Grace leads partnerships at Acme.", frontmatter: {},
      }));
      let archive = edited.archive_path!;
      if (legacy) {
        const renamed = `archive/${basename(created.page_path, ".md")}.prev-20260101.md`;
        renameSync(join(ctx.vault, archive), join(ctx.vault, renamed));
        ctx.db.query("UPDATE canon_receipts SET archive_path=? WHERE receipt_id=?").run(renamed, edited.receipt_id);
        archive = renamed;
      }
      putPage(ctx.vault, "archive/unrelated.md", "unrelated-archive");
      const backup = join(parent, "backup"), target = join(parent, "restored");
      exportVault(ctx.db, ctx.vault, backup);
      const listing = inventory(backup);
      expect(listing.files.filter(file => file.kind === "archive").map(file => file.path)).toEqual([archive]);
      expect(readFileSync(join(backup, "vault", archive))).toEqual(prior);
      expect(listing.unavailable_archive_references).toBe(0);
      restoreVault(backup, target);
      const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
      try {
        await undoReceipt({ db: restored, vault_path: target }, edited.receipt_id);
        expect(readFileSync(join(target, created.page_path))).toEqual(prior);
      } finally { restored.close(); }
    });
  }

  test("reports unavailable receipt archives without selecting unrelated replacement bytes", async () => {
    const ctx = canonFixture();
    disposers.push(ctx.dispose);
    const parent = mkdtempSync(join(tmpdir(), "kizuki-export-unavailable-"));
    disposers.push(() => rmSync(parent, { recursive: true, force: true }));
    const event = putEvent(ctx.db);
    write(ctx.io, await storeClaim(ctx.db, event));
    const edited = write(ctx.io, await storeClaim(ctx.db, event, {
      kind: "edit", predicate: null, object: null, body: "Grace leads partnerships at Acme.", frontmatter: {},
    }));
    putPage(ctx.vault, edited.archive_path!, "unrelated-replacement");
    const backup = join(parent, "backup");
    const manifest = exportVault(ctx.db, ctx.vault, backup);
    expect(manifest.files[`vault/${edited.archive_path}`]).toBeUndefined();
    expect(inventory(backup).unavailable_archive_references).toBe(1);
    expect(inventory(backup).recovery_limits.join(" ")).toContain("does not assert complete runtime recovery");
  });
});

describe("manifest-declared restore streams", () => {
  test("does not read an optional stream that is not declared", () => {
    const { db, vault, backup, target } = fixture();
    db.query("INSERT INTO connector_sensitivity (connector_id,source_key,default_sensitivity,floor,set_by,at) VALUES ('fixture','synthetic-source','private','private','owner','2026-01-01T00:00:00Z')").run();
    const manifest = exportVault(db, vault, backup);
    omitDeclaration(backup, manifest, "ledger/connector_sensitivity.jsonl");
    expect(existsSync(join(backup, "ledger", "connector_sensitivity.jsonl"))).toBe(true);
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try { expect(restored.query("SELECT * FROM connector_sensitivity").all()).toEqual([]); }
    finally { restored.close(); }
  });

  test("refuses a required undeclared stream even when its file exists", () => {
    const { db, vault, backup, target } = fixture();
    const manifest = exportVault(db, vault, backup);
    omitDeclaration(backup, manifest, "ledger/events.jsonl");
    expect(() => restoreVault(backup, target)).toThrow("backup manifest is missing ledger/events.jsonl");
    expect(existsSync(target)).toBe(false);
  });
});
