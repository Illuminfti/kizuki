import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkProvenance,
  discoverSkillFiles,
  loadSkillState,
  lockedPaths,
  parseProvenanceLock,
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
});
