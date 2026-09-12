import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault } from "@kizuki/core";
import { createMarkdownFolderConnector } from "../src/markdown-folder";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  // Vault custody rejects aliased ancestors, including macOS's /tmp alias.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kizuki-markdown-vault-"))), vault = join(root, "vault");
  roots.push(root); initVault(vault); mkdirSync(join(vault, "auto"));
  writeFileSync(join(vault, "auto", "synthetic.md"), "SYNTHETIC_GENERATED_CANON\n");
  writeFileSync(join(root, "first.md"), "SYNTHETIC_ORDINARY_SOURCE\n");
  return { root, vault };
}

function replaceDirectoryOnOpen(
  directory: string,
  target: string,
  filePath: string,
): ReturnType<typeof spyOn> {
  const original = filesystem.open;
  let replaced = false;
  const pinnedDirectory = resolve(directory);
  const pinnedFile = resolve(filePath);
  const fileName = filePath.split("/").pop()!;
  return spyOn(filesystem, "open").mockImplementation(((
    ...args: Parameters<typeof original>
  ) => {
    const candidate = String(args[0]);
    const resolved = resolve(candidate);
    if (
      !replaced &&
      (resolved === pinnedDirectory ||
        resolved === pinnedFile ||
        (candidate.startsWith("/proc/self/fd/") && candidate.endsWith(`/${fileName}`)) ||
        (candidate.startsWith("/dev/fd/") && candidate.endsWith(`/${fileName}`)))
    ) {
      replaced = true;
      renameSync(directory, `${directory}.replaced`);
      symlinkSync(target, directory);
    }
    return original(...args);
  }) as typeof original);
}

function hideDescriptorPathsAndReplaceAfterParentOpen(
  directory: string,
  target: string,
): { restore(): void } {
  const originalOpen = filesystem.open;
  const originalStat = filesystem.stat;
  let replaced = false;
  const pinnedDirectory = resolve(directory);
  const opening = spyOn(filesystem, "open").mockImplementation(((
    ...args: Parameters<typeof originalOpen>
  ) => {
    const candidate = String(args[0]);
    if (/^\/(?:proc\/self|dev)\/fd\/\d+\//.test(candidate)) {
      const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(error);
    }
    const opened = originalOpen(...args);
    return Promise.resolve(opened).then((handle) => {
      if (!replaced && resolve(String(args[0])) === pinnedDirectory) {
        replaced = true;
        renameSync(directory, `${directory}.replaced`);
        symlinkSync(target, directory);
      }
      return handle;
    });
  }) as typeof originalOpen);
  const stating = spyOn(filesystem, "stat").mockImplementation(((
    ...args: Parameters<typeof originalStat>
  ) => {
    const candidate = String(args[0]);
    if (candidate === "/proc/self/fd" || candidate === "/dev/fd") {
      const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(error);
    }
    return originalStat(...args);
  }) as typeof originalStat);
  return {
    restore() {
      opening.mockRestore();
      stating.mockRestore();
    },
  };
}

test("a vault, its descendants, and a scanned ancestor refuse the whole capture", async () => {
  const { root, vault } = fixture();
  for (const source of [vault, join(vault, "auto"), join(vault, "archive"), join(vault, ".kizuki"), root]) {
    const connector = createMarkdownFolderConnector({ path: source });
    await expect(connector.backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
    expect((await connector.health()).state).toBe("misconfigured");
  }
});

test("aliases and excluded control names cannot hide vault identity", async () => {
  const { root, vault } = fixture();
  const alias = join(root, "alias"); symlinkSync(join(vault, "auto"), alias);
  await expect(createMarkdownFolderConnector({ path: alias }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
  await expect(createMarkdownFolderConnector({ path: vault, exclude: [".kizuki"] }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
  const source = mkdtempSync("/tmp/kizuki-markdown-control-"); roots.push(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SOURCE\n");
  symlinkSync(join(source, "absent-control-target"), join(source, ".kizuki"));
  await expect(createMarkdownFolderConnector({ path: source }).backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
});

test("a source becoming a vault refuses restart without turning prior notes into tombstones", async () => {
  const source = mkdtempSync("/tmp/kizuki-markdown-source-"); roots.push(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SOURCE\n");
  const connector = createMarkdownFolderConnector({ path: source });
  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(1);
  mkdirSync(join(source, ".kizuki"));
  await expect(connector.sync(first.cursor)).rejects.toThrow("source_contains_kizuki_vault");
  rmSync(join(source, ".kizuki"), { recursive: true });
  expect((await connector.sync(first.cursor)).events).toEqual([]);
});

test("replacing a nested directory with a vault auto or archive symlink at the final open emits no vault bytes", async () => {
  const { root, vault } = fixture();
  writeFileSync(join(vault, "auto", "inside.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "auto", "leak.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "archive", "inside.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "archive", "leak.md"), "MUST_NOT_CAPTURE\n");
  for (const child of ["auto", "archive"] as const) {
    const source = join(root, `notes-open-${child}`);
    const nested = join(source, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(source, "own.md"), "SYNTHETIC_SIBLING_SOURCE\n");
    writeFileSync(join(nested, "inside.md"), "inside\n");
    const pinnedNested = join(realpathSync(source), "nested");
    const opening = replaceDirectoryOnOpen(
      pinnedNested,
      join(vault, child),
      join(pinnedNested, "inside.md"),
    );
    try {
      const connector = createMarkdownFolderConnector({ path: source });
      let batch: Awaited<ReturnType<typeof connector.backfill>> | undefined;
      try {
        batch = await connector.backfill(null);
      } catch (error) {
        expect(String(error)).toContain("source_contains_kizuki_vault");
      }
      expect(readFileSync(join(pinnedNested, "inside.md"), "utf8")).toBe("MUST_NOT_CAPTURE\n");
      if (batch !== undefined) {
        expect(JSON.stringify(batch)).not.toContain("MUST_NOT_CAPTURE");
        expect(batch.events.some(event => event.deleted)).toBe(false);
        const inside = batch.events.find(event => event.source_record_id === "nested/inside.md");
        if (inside !== undefined) expect(inside.text).toBe("inside\n");
      }
    } finally {
      opening.mockRestore();
    }
  }
});

test("a final-open vault swap does not tombstone a previously captured nested file", async () => {
  const { root, vault } = fixture();
  writeFileSync(join(vault, "auto", "inside.md"), "MUST_NOT_CAPTURE\n");
  const source = join(root, "notes-open-tombstone");
  const nested = join(source, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(source, "own.md"), "SYNTHETIC_SIBLING_SOURCE\n");
  writeFileSync(join(nested, "inside.md"), "inside\n");
  const connector = createMarkdownFolderConnector({ path: source });
  const first = await connector.backfill(null);
  expect(first.events.map(event => event.source_record_id).sort()).toEqual([
    "nested/inside.md",
    "own.md",
  ]);
  const pinnedNested = join(realpathSync(source), "nested");
  const opening = replaceDirectoryOnOpen(
    pinnedNested,
    join(vault, "auto"),
    join(pinnedNested, "inside.md"),
  );
  try {
    let batch: Awaited<ReturnType<typeof connector.sync>> | undefined;
    try {
      batch = await connector.sync(first.cursor);
    } catch (error) {
      expect(String(error)).toContain("source_contains_kizuki_vault");
    }
    expect(readFileSync(join(pinnedNested, "inside.md"), "utf8")).toBe("MUST_NOT_CAPTURE\n");
    if (batch !== undefined) {
      expect(JSON.stringify(batch)).not.toContain("MUST_NOT_CAPTURE");
      expect(batch.events.filter(event => event.deleted).map(event => event.source_record_id))
        .not.toContain("nested/inside.md");
      expect(JSON.parse(batch.cursor ?? "{}").files.map(([relpath]: [string]) => relpath))
        .toContain("nested/inside.md");
    }
  } finally {
    opening.mockRestore();
  }
});

test("a no-proc final-open vault swap emits no vault bytes", async () => {
  const { root, vault } = fixture();
  writeFileSync(join(vault, "auto", "inside.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "auto", "leak.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "archive", "inside.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "archive", "leak.md"), "MUST_NOT_CAPTURE\n");
  for (const child of ["auto", "archive"] as const) {
    const source = join(root, `notes-noproc-open-${child}`);
    const nested = join(source, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(source, "own.md"), "SYNTHETIC_SIBLING_SOURCE\n");
    writeFileSync(join(nested, "inside.md"), "inside\n");
    const pinnedNested = join(realpathSync(source), "nested");
    const opening = hideDescriptorPathsAndReplaceAfterParentOpen(
      pinnedNested,
      join(vault, child),
    );
    try {
      const connector = createMarkdownFolderConnector({ path: source });
      let batch: Awaited<ReturnType<typeof connector.backfill>> | undefined;
      try {
        batch = await connector.backfill(null);
      } catch (error) {
        expect(String(error)).toContain("source_contains_kizuki_vault");
      }
      expect(readFileSync(join(pinnedNested, "inside.md"), "utf8")).toBe("MUST_NOT_CAPTURE\n");
      if (batch !== undefined) {
        expect(JSON.stringify(batch)).not.toContain("MUST_NOT_CAPTURE");
        expect(batch.events.some(event => event.deleted)).toBe(false);
        const inside = batch.events.find(event => event.source_record_id === "nested/inside.md");
        if (inside !== undefined) expect(inside.text).toBe("inside\n");
      }
    } finally {
      opening.restore();
    }
  }
});

test("a no-proc final-open vault swap does not tombstone a previously captured nested file", async () => {
  const { root, vault } = fixture();
  writeFileSync(join(vault, "auto", "inside.md"), "MUST_NOT_CAPTURE\n");
  const source = join(root, "notes-noproc-open-tombstone");
  const nested = join(source, "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(source, "own.md"), "SYNTHETIC_SIBLING_SOURCE\n");
  writeFileSync(join(nested, "inside.md"), "inside\n");
  const connector = createMarkdownFolderConnector({ path: source });
  const first = await connector.backfill(null);
  expect(first.events.map(event => event.source_record_id).sort()).toEqual([
    "nested/inside.md",
    "own.md",
  ]);
  const pinnedNested = join(realpathSync(source), "nested");
  const opening = hideDescriptorPathsAndReplaceAfterParentOpen(
    pinnedNested,
    join(vault, "auto"),
  );
  try {
    let batch: Awaited<ReturnType<typeof connector.sync>> | undefined;
    try {
      batch = await connector.sync(first.cursor);
    } catch (error) {
      expect(String(error)).toContain("source_contains_kizuki_vault");
    }
    expect(readFileSync(join(pinnedNested, "inside.md"), "utf8")).toBe("MUST_NOT_CAPTURE\n");
    if (batch !== undefined) {
      expect(JSON.stringify(batch)).not.toContain("MUST_NOT_CAPTURE");
      expect(batch.events.filter(event => event.deleted).map(event => event.source_record_id))
        .not.toContain("nested/inside.md");
      expect(JSON.parse(batch.cursor ?? "{}").files.map(([relpath]: [string]) => relpath))
        .toContain("nested/inside.md");
    }
  } finally {
    opening.restore();
  }
});

test("replacing a nested directory with a vault auto or archive symlink refuses the scan", async () => {
  const { root, vault } = fixture();
  writeFileSync(join(vault, "auto", "leak.md"), "MUST_NOT_CAPTURE\n");
  writeFileSync(join(vault, "archive", "leak.md"), "MUST_NOT_CAPTURE\n");
  for (const child of ["auto", "archive"] as const) {
    const source = join(root, `notes-${child}`);
    const nested = join(source, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(source, "own.md"), "SYNTHETIC_SIBLING_SOURCE\n");
    writeFileSync(join(nested, "inside.md"), "inside\n");
    const pinnedNested = join(realpathSync(source), "nested");
    const original = filesystem.readdir;
    let replaced = false;
    const listing = spyOn(filesystem, "readdir").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      if (!replaced && resolve(String(args[0])) === resolve(pinnedNested)) {
        replaced = true;
        renameSync(pinnedNested, `${pinnedNested}.replaced`);
        symlinkSync(join(vault, child), pinnedNested);
      }
      return original(...args);
    }) as typeof original);
    try {
      const connector = createMarkdownFolderConnector({ path: source });
      await expect(connector.backfill(null)).rejects.toThrow("source_contains_kizuki_vault");
    } finally {
      listing.mockRestore();
    }
  }
});

test("an independent sibling folder remains a usable source", async () => {
  const { root } = fixture();
  const source = join(root, "notes"); mkdirSync(source);
  writeFileSync(join(source, "note.md"), "SYNTHETIC_SIBLING_SOURCE\n");
  const result = await createMarkdownFolderConnector({ path: source }).backfill(null);
  expect(result.events.map(event => event.text)).toEqual(["SYNTHETIC_SIBLING_SOURCE\n"]);
});
