import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  adoptionCommand,
  checkProvenance,
  discoverSkillFiles,
  loadSkillState,
  lockedPaths,
  parseProvenanceLock,
  previewAdoption,
  repairAdoption,
  rollbackAdoption,
  type FileState,
} from "./skill-provenance";

const root = join(import.meta.dir, "..");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function read(path: string): string {
  return decoder.decode(readFileSync(path));
}

function bytes(text: string): FileState {
  return { kind: "bytes", bytes: new TextEncoder().encode(text) };
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const canonical = ".agents/skills/implement-change/SKILL.md";
const pointer = ".claude/skills/implement-change/SKILL.md";
const pointerText = "Read `../../../.agents/skills/implement-change/SKILL.md` and follow it exactly.\n";
const canonicalText = "# Implement change\n\nRepair the bounded behavior.\n";

function sampleLock(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: "kizuki.skill-provenance/v1",
    digest: "sha256",
    notice: "Content-addressed inventory. This checker never installs or fetches.",
    copiedUpstream: [],
    excluded: ["semantic-algos"],
    entries: [
      {
        id: "implement-change",
        role: "kizuki-owned",
        license: "MIT",
        notice: "Kizuki-owned playbook. Covered by the repository LICENSE. No upstream file is copied.",
        canonical,
        sha256: sha256(canonicalText),
        hosts: [
          {
            path: pointer,
            kind: "pointer",
            sha256: sha256(pointerText),
            target: canonical,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function sampleFiles(): Map<string, FileState> {
  return new Map<string, FileState>([
    [canonical, bytes(canonicalText)],
    [pointer, bytes(pointerText)],
  ]);
}

describe("skill provenance", () => {
  test("a matching lock and content pass", () => {
    const lock = parseProvenanceLock(sampleLock());
    expect(checkProvenance(lock, sampleFiles(), [canonical, pointer])).toEqual([]);
  });

  test("a missing canonical file is a missing source, not an install", () => {
    const lock = parseProvenanceLock(sampleLock());
    const files = sampleFiles();
    files.set(canonical, { kind: "missing" });
    expect(checkProvenance(lock, files)).toContain(`missing source: ${canonical}`);
    expect(checkProvenance(lock, files).join("\n")).not.toContain("install");
  });

  test("changed bytes at the same path fail the content digest", () => {
    const lock = parseProvenanceLock(sampleLock());
    const files = sampleFiles();
    files.set(canonical, bytes(`${canonicalText}\nchanged\n`));
    expect(checkProvenance(lock, files).some((error) => error.startsWith(`digest mismatch: ${canonical} lock `))).toBe(true);
  });

  test("a pointer that names another skill is a stale adapter even when its digest is locked", () => {
    const stale = "Read `../../../.agents/skills/review-change/SKILL.md` and follow it exactly.\n";
    const raw = sampleLock();
    const entry = (raw as { entries: Array<{ hosts: Array<{ sha256: string }> }> }).entries[0];
    if (entry === undefined) throw new Error("sample entry missing");
    const host = entry.hosts[0];
    if (host === undefined) throw new Error("sample host missing");
    host.sha256 = sha256(stale);
    const lock = parseProvenanceLock(raw);
    const files = sampleFiles();
    files.set(pointer, bytes(stale));
    expect(checkProvenance(lock, files)).toContain(
      `stale adapter reference: ${pointer} resolves to .agents/skills/review-change/SKILL.md`,
    );
  });

  test("a copy whose bytes differ from canonical diverges", () => {
    const copy = ".cursor/skills/show-me/SKILL.md";
    const source = ".claude/skills/show-me/SKILL.md";
    const body = "# Show me\n";
    const other = "# Show me\n\nchanged\n";
    const lock = parseProvenanceLock(sampleLock({
      entries: [
        {
          id: "show-me",
          role: "house-overlay",
          license: "MIT",
          notice: "Kizuki house overlay. Host copies must match this canonical file.",
          canonical: source,
          sha256: sha256(body),
          hosts: [{ path: copy, kind: "copy", sha256: sha256(other), target: source }],
        },
      ],
    }));
    const files = new Map<string, FileState>([
      [source, bytes(body)],
      [copy, bytes(other)],
    ]);
    expect(checkProvenance(lock, files)).toContain(`copy diverges from canonical: ${copy}`);
  });

  test("an untracked skill file fails", () => {
    const lock = parseProvenanceLock(sampleLock());
    expect(checkProvenance(lock, sampleFiles(), [canonical, pointer, ".agents/skills/extra/SKILL.md"])).toContain(
      "untracked skill file: .agents/skills/extra/SKILL.md",
    );
  });

  test("a blank notice is incomplete attribution", () => {
    const raw = sampleLock();
    (raw as { entries: Array<{ notice: string }> }).entries[0]!.notice = " ";
    expect(() => parseProvenanceLock(raw)).toThrow("incomplete attribution: implement-change");
  });

  test("an unknown license fails closed", () => {
    const raw = sampleLock();
    (raw as { entries: Array<{ license: string }> }).entries[0]!.license = "proprietary";
    expect(() => parseProvenanceLock(raw)).toThrow("unknown license: implement-change");
  });

  test("a vendor stub cannot be cleared as MIT", () => {
    expect(() => parseProvenanceLock(sampleLock({
      entries: [
        {
          id: "kun",
          role: "vendor-stub",
          license: "MIT",
          notice: "Local vendor stub only. Upstream is not license-cleared.",
          canonical: ".agents/skills/kun/SKILL.md",
          sha256: sha256("stub"),
          hosts: [],
        },
      ],
    }))).toThrow("vendor stub is not license-cleared: kun");
  });

  test("an inconsistent host target is refused", () => {
    const raw = sampleLock();
    (raw as { entries: Array<{ hosts: Array<{ target: string }> }> }).entries[0]!.hosts[0]!.target =
      ".agents/skills/review-change/SKILL.md";
    expect(() => parseProvenanceLock(raw)).toThrow(`inconsistent target: ${pointer} expected ${canonical}`);
  });

  test("excluded semantic material and upstream copies are refused", () => {
    expect(() => parseProvenanceLock(sampleLock({ copiedUpstream: ["semantic-algos"] }))).toThrow(
      "copiedUpstream must be an empty list",
    );
    const raw = sampleLock();
    (raw as { entries: Array<{ id: string }> }).entries[0]!.id = "semantic-algos";
    expect(() => parseProvenanceLock(raw)).toThrow("excluded material: semantic-algos");
  });

  test("an unsafe path and a symlink are refused", () => {
    const raw = sampleLock();
    (raw as { entries: Array<{ canonical: string }> }).entries[0]!.canonical = "../secrets/SKILL.md";
    expect(() => parseProvenanceLock(raw)).toThrow("refused unsafe path: implement-change");

    const dir = join(tmpdir(), `skill-provenance-${process.pid}`);
    mkdirSync(join(dir, ".agents", "skills", "linked"), { recursive: true });
    writeFileSync(join(dir, "target.md"), "not a skill\n");
    symlinkSync(join(dir, "target.md"), join(dir, ".agents", "skills", "linked", "SKILL.md"));
    expect(loadSkillState(dir, ".agents/skills/linked/SKILL.md")).toEqual({ kind: "symlink" });
  });

  test("the live lock matches adopted skill bytes and cites no install", () => {
    const source = read(join(import.meta.dir, "skill-provenance.ts"));
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("spawn");
    const lock = parseProvenanceLock(JSON.parse(read(join(root, "scripts", "skill-provenance.lock.json"))));
    expect(lock.copiedUpstream).toEqual([]);
    expect(lock.excluded).toEqual(["semantic-algos"]);
    const discovered = discoverSkillFiles(root);
    expect(discovered.errors).toEqual([]);
    const files = new Map<string, FileState>();
    for (const path of lockedPaths(lock)) files.set(path, loadSkillState(root, path));
    expect(checkProvenance(lock, files, discovered.paths)).toEqual([]);
    expect(lock.entries.find((entry) => entry.id === "kun")?.license).toBe("unverified-upstream");
  });

  test("dry-run requires a destination and repair is a separate write command", () => {
    expect(adoptionCommand(["--dry-run"])).toEqual({
      mode: "refused",
      reason: "selected destination is required",
    });
    expect(adoptionCommand(["--repair"])).toEqual({
      mode: "refused",
      reason: "selected destination is required",
    });
    expect(adoptionCommand(["--apply", "--destination", pointer])).toEqual({
      mode: "refused",
      reason: "--apply is refused; use --repair with a selected destination",
    });
    expect(adoptionCommand(["--repair", "--dry-run", "--destination", pointer])).toEqual({
      mode: "refused",
      reason: "dry-run performs no writes",
    });
    expect(adoptionCommand(["--repair", "--destination", pointer])).toEqual({
      mode: "repair",
      destination: pointer,
    });
    expect(adoptionCommand([])).toEqual({ mode: "verify" });
  });

  test("dry-run previews a drifted copy twice and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-dry-run-"));
    const source = ".agents/skills/elegance-review/SKILL.md";
    const copy = ".claude/skills/elegance-review/SKILL.md";
    const unrelated = ".claude/skills/elegance-review/NOTES.md";
    const body = "# Elegance\n";
    const drifted = "# Elegance\n\ndrift\n";
    mkdirSync(join(dir, ".agents", "skills", "elegance-review"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "elegance-review"), { recursive: true });
    writeFileSync(join(dir, source), body);
    writeFileSync(join(dir, copy), drifted);
    writeFileSync(join(dir, unrelated), "leave me\n");
    const lock = parseProvenanceLock(sampleLock({
      entries: [
        {
          id: "elegance-review",
          role: "house-overlay",
          license: "MIT",
          notice: "Kizuki house overlay. Host copies must match this canonical file.",
          canonical: source,
          sha256: sha256(body),
          hosts: [{ path: copy, kind: "copy", sha256: sha256(body), target: source }],
        },
      ],
    }));
    const files = new Map<string, FileState>([
      [source, loadSkillState(dir, source)],
      [copy, loadSkillState(dir, copy)],
    ]);
    const first = previewAdoption(lock, files, copy);
    expect(previewAdoption(lock, files, copy)).toEqual(first);
    expect(first).toEqual({
      writes: false,
      destination: copy,
      action: {
        kind: "would-restore",
        path: copy,
        from: source,
        sha256: sha256(body),
        bytes: new TextEncoder().encode(body).byteLength,
      },
    });
    expect(readFileSync(join(dir, copy), "utf8")).toBe(drifted);
    expect(readFileSync(join(dir, source), "utf8")).toBe(body);
    expect(readFileSync(join(dir, unrelated), "utf8")).toBe("leave me\n");
  });

  test("dry-run refuses a symlink, an unsafe path, and a canonical target", () => {
    const lock = parseProvenanceLock(sampleLock());
    expect(() => previewAdoption(lock, sampleFiles(), "../secrets/SKILL.md")).toThrow(
      "refused unsafe path: destination",
    );
    expect(previewAdoption(lock, sampleFiles(), canonical).action).toEqual({
      kind: "refused",
      path: canonical,
      reason: "canonical drift is a lock failure, not a repair target",
    });

    const dir = mkdtempSync(join(tmpdir(), "skill-dry-run-link-"));
    const copy = ".claude/skills/implement-change/SKILL.md";
    mkdirSync(join(dir, ".claude", "skills", "implement-change"), { recursive: true });
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "owned\n");
    symlinkSync(outside, join(dir, copy));
    const files = new Map<string, FileState>([[copy, loadSkillState(dir, copy)]]);
    expect(previewAdoption(lock, files, copy).action).toEqual({
      kind: "refused",
      path: copy,
      reason: "refused symlink",
    });
    expect(lstatSync(join(dir, copy)).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("owned\n");
  });

  test("the live dry-run command does not change an adopted copy", () => {
    const dest = ".claude/skills/elegance-review/SKILL.md";
    const before = readFileSync(join(root, dest));
    const previewRun = Bun.spawnSync(
      ["bun", "scripts/skill-provenance.ts", "--dry-run", "--destination", dest],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(previewRun.exitCode).toBe(0);
    const preview = JSON.parse(new TextDecoder().decode(previewRun.stdout)) as { writes: boolean; action: { kind: string } };
    expect(preview.writes).toBe(false);
    expect(preview.action.kind).toBe("unchanged");
    const repair = Bun.spawnSync(
      ["bun", "scripts/skill-provenance.ts", "--repair", "--destination", dest],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(repair.exitCode).toBe(0);
    const receipt = JSON.parse(new TextDecoder().decode(repair.stdout)) as { writes: boolean; action: string };
    expect(receipt.writes).toBe(false);
    expect(receipt.action).toBe("unchanged");
    expect(readFileSync(join(root, dest))).toEqual(before);
    expect(read(join(import.meta.dir, "skill-provenance.ts"))).not.toContain("fetch(");
    expect(read(join(import.meta.dir, "skill-provenance.ts"))).not.toContain("child_process");
  });

  test("repair backs up a drifted copy, restores it, and rolls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-repair-"));
    const backupDir = mkdtempSync(join(tmpdir(), "skill-repair-bak-"));
    const source = ".agents/skills/elegance-review/SKILL.md";
    const copy = ".claude/skills/elegance-review/SKILL.md";
    const unrelated = ".claude/skills/elegance-review/NOTES.md";
    const body = "# Elegance\n";
    const drifted = "# Elegance\n\ndrift\n";
    mkdirSync(join(dir, ".agents", "skills", "elegance-review"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "elegance-review"), { recursive: true });
    writeFileSync(join(dir, source), body);
    writeFileSync(join(dir, copy), drifted);
    writeFileSync(join(dir, unrelated), "leave me\n");
    const lock = parseProvenanceLock(sampleLock({
      entries: [
        {
          id: "elegance-review",
          role: "house-overlay",
          license: "MIT",
          notice: "Kizuki house overlay. Host copies must match this canonical file.",
          canonical: source,
          sha256: sha256(body),
          hosts: [{ path: copy, kind: "copy", sha256: sha256(body), target: source }],
        },
      ],
    }));

    const first = repairAdoption(dir, lock, copy, backupDir);
    expect(first.writes).toBe(true);
    if (first.action !== "restored") throw new Error(`expected restore, got ${first.action}`);
    expect(first.before).toBe(sha256(drifted));
    expect(first.after).toBe(sha256(body));
    expect(readFileSync(first.backup, "utf8")).toBe(drifted);
    expect(readFileSync(join(dir, copy), "utf8")).toBe(body);
    expect(readFileSync(join(dir, source), "utf8")).toBe(body);
    expect(readFileSync(join(dir, unrelated), "utf8")).toBe("leave me\n");

    expect(repairAdoption(dir, lock, copy, backupDir)).toEqual({
      writes: false,
      destination: copy,
      action: "unchanged",
      sha256: sha256(body),
    });

    const undone = rollbackAdoption(dir, lock, copy, first.backup);
    expect(undone.writes).toBe(true);
    if (undone.action !== "rolled-back") throw new Error(`expected rollback, got ${undone.action}`);
    expect(readFileSync(join(dir, copy), "utf8")).toBe(drifted);
    expect(readFileSync(join(dir, source), "utf8")).toBe(body);
    expect(readFileSync(join(dir, unrelated), "utf8")).toBe("leave me\n");
    expect(rollbackAdoption(dir, lock, copy, first.backup).writes).toBe(false);
    expect(readFileSync(join(dir, copy), "utf8")).toBe(drifted);
  });

  test("repair refuses a symlink, a missing copy, and a backup inside the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-repair-refuse-"));
    const source = ".agents/skills/elegance-review/SKILL.md";
    const copy = ".claude/skills/elegance-review/SKILL.md";
    const body = "# Elegance\n";
    mkdirSync(join(dir, ".agents", "skills", "elegance-review"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "elegance-review"), { recursive: true });
    writeFileSync(join(dir, source), body);
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "owned\n");
    symlinkSync(outside, join(dir, copy));
    const lock = parseProvenanceLock(sampleLock({
      entries: [
        {
          id: "elegance-review",
          role: "house-overlay",
          license: "MIT",
          notice: "Kizuki house overlay. Host copies must match this canonical file.",
          canonical: source,
          sha256: sha256(body),
          hosts: [{ path: copy, kind: "copy", sha256: sha256(body), target: source }],
        },
      ],
    }));
    const inside = join(dir, "backup");
    mkdirSync(inside);
    expect(repairAdoption(dir, lock, copy, inside)).toEqual({
      writes: false,
      destination: copy,
      action: "refused",
      reason: "refused symlink",
    });
    expect(lstatSync(join(dir, copy)).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("owned\n");

    const missingDir = mkdtempSync(join(tmpdir(), "skill-repair-missing-"));
    const missingCopy = ".claude/skills/elegance-review/SKILL.md";
    mkdirSync(join(missingDir, ".agents", "skills", "elegance-review"), { recursive: true });
    mkdirSync(join(missingDir, ".claude", "skills", "elegance-review"), { recursive: true });
    writeFileSync(join(missingDir, source), body);
    const backupDir = mkdtempSync(join(tmpdir(), "skill-repair-missing-bak-"));
    expect(repairAdoption(missingDir, lock, missingCopy, backupDir)).toEqual({
      writes: false,
      destination: missingCopy,
      action: "refused",
      reason: "missing destination; repair does not install",
    });
    expect(() => readFileSync(join(missingDir, missingCopy))).toThrow();

    const insideDir = mkdtempSync(join(tmpdir(), "skill-repair-inside-"));
    mkdirSync(join(insideDir, ".agents", "skills", "elegance-review"), { recursive: true });
    mkdirSync(join(insideDir, ".claude", "skills", "elegance-review"), { recursive: true });
    writeFileSync(join(insideDir, source), body);
    writeFileSync(join(insideDir, copy), `${body}drift\n`);
    const insideBackup = join(insideDir, "backup");
    mkdirSync(insideBackup);
    expect(repairAdoption(insideDir, lock, copy, insideBackup)).toEqual({
      writes: false,
      destination: copy,
      action: "refused",
      reason: "refused unsafe path: backup",
    });
    expect(readFileSync(join(insideDir, copy), "utf8")).toBe(`${body}drift\n`);
    expect(readFileSync(join(insideDir, source), "utf8")).toBe(body);
  });
});
