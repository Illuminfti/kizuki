import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillRole = "kizuki-owned" | "house-overlay" | "vendor-stub";
export type HostKind = "pointer" | "copy";

export type SkillHost = {
  readonly path: string;
  readonly kind: HostKind;
  readonly sha256: string;
  readonly target: string;
};

export type SkillEntry = {
  readonly id: string;
  readonly role: SkillRole;
  readonly license: string;
  readonly notice: string;
  readonly canonical: string;
  readonly sha256: string;
  readonly hosts: readonly SkillHost[];
};

export type ProvenanceLock = {
  readonly schema: "kizuki.skill-provenance/v1";
  readonly digest: "sha256";
  readonly notice: string;
  readonly copiedUpstream: readonly [];
  readonly excluded: readonly ["semantic-algos"];
  readonly entries: readonly SkillEntry[];
};

export type FileState =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "symlink" }
  | { readonly kind: "unsafe" };

const SCHEMA = "kizuki.skill-provenance/v1";
const HOMES = [".agents/skills", ".claude/skills", ".cursor/skills"] as const;
const CITATION = /`((?:\.\.\/)+.agents\/skills\/[a-z0-9-]+\/SKILL\.md)`/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRepoPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`refused unsafe path: ${label}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`refused unsafe path: ${label}`);
  }
  return value;
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`digest mismatch: ${label} is not a sha256`);
  }
  return value;
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`incomplete attribution: ${label}`);
  }
  return value;
}

function containsExcluded(value: string): boolean {
  return value.toLowerCase().includes("semantic-algos");
}

function licenseFor(role: SkillRole, license: string, id: string): string {
  if (role === "vendor-stub") {
    if (license !== "unverified-upstream") throw new Error(`vendor stub is not license-cleared: ${id}`);
    return license;
  }
  if (license !== "MIT") throw new Error(`unknown license: ${id}`);
  return license;
}

function resolveCitation(fromFile: string, relative: string): string | null {
  const parts = fromFile.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (part === "" || part === "." || part === "..") return null;
    parts.push(part);
  }
  return parts.join("/");
}

function citations(text: string): string[] {
  return [...text.matchAll(CITATION)].map((match) => match[1]).filter((item): item is string => item !== undefined);
}

export function parseProvenanceLock(value: unknown): ProvenanceLock {
  if (!isRecord(value)) throw new Error("provenance lock must be an object");
  if (value["schema"] !== SCHEMA) throw new Error(`schema must be ${SCHEMA}`);
  if (value["digest"] !== "sha256") throw new Error("digest must be sha256");
  const notice = assertText(value["notice"], "lock notice");
  if (containsExcluded(notice)) throw new Error("excluded material: lock notice");
  if (!Array.isArray(value["copiedUpstream"]) || value["copiedUpstream"].length !== 0) {
    throw new Error("copiedUpstream must be an empty list");
  }
  const excluded = value["excluded"];
  if (!Array.isArray(excluded) || excluded.length !== 1 || excluded[0] !== "semantic-algos") {
    throw new Error('excluded must be ["semantic-algos"]');
  }
  if (!Array.isArray(value["entries"]) || value["entries"].length === 0) {
    throw new Error("entries must be a non-empty list");
  }

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const entries = value["entries"].map((entry, index) => parseEntry(entry, index, seenIds, seenPaths));
  return {
    schema: SCHEMA,
    digest: "sha256",
    notice,
    copiedUpstream: [],
    excluded: ["semantic-algos"],
    entries,
  };
}

function parseEntry(
  value: unknown,
  index: number,
  seenIds: Set<string>,
  seenPaths: Set<string>,
): SkillEntry {
  if (!isRecord(value)) throw new Error(`entries[${index}] must be an object`);
  const id = assertText(value["id"], `entries[${index}].id`);
  if (seenIds.has(id)) throw new Error(`duplicate entry: ${id}`);
  seenIds.add(id);
  if (containsExcluded(id)) throw new Error(`excluded material: ${id}`);
  const role = value["role"];
  if (role !== "kizuki-owned" && role !== "house-overlay" && role !== "vendor-stub") {
    throw new Error(`unknown role: ${id}`);
  }
  const license = licenseFor(role, assertText(value["license"], id), id);
  const notice = assertText(value["notice"], id);
  if (containsExcluded(notice)) throw new Error(`excluded material: ${id}`);
  const canonical = claimPath(value["canonical"], id, seenPaths);
  const sha256 = assertSha256(value["sha256"], canonical);
  if (!Array.isArray(value["hosts"])) throw new Error(`incomplete attribution: ${id} hosts`);
  const hosts = value["hosts"].map((host, hostIndex) => parseHost(host, id, hostIndex, canonical, seenPaths));
  return { id, role, license, notice, canonical, sha256, hosts };
}

function claimPath(value: unknown, label: string, seenPaths: Set<string>): string {
  const path = assertRepoPath(value, label);
  if (containsExcluded(path)) throw new Error(`excluded material: ${path}`);
  if (seenPaths.has(path)) throw new Error(`duplicate path: ${path}`);
  seenPaths.add(path);
  return path;
}

function parseHost(
  value: unknown,
  id: string,
  index: number,
  canonical: string,
  seenPaths: Set<string>,
): SkillHost {
  if (!isRecord(value)) throw new Error(`incomplete attribution: ${id} host ${index}`);
  const path = claimPath(value["path"], `${id} host ${index}`, seenPaths);
  const kind = value["kind"];
  if (kind !== "pointer" && kind !== "copy") throw new Error(`unknown host kind: ${path}`);
  const target = assertRepoPath(value["target"], path);
  if (target !== canonical) throw new Error(`inconsistent target: ${path} expected ${canonical}`);
  return { path, kind, sha256: assertSha256(value["sha256"], path), target };
}

export function lockedPaths(lock: ProvenanceLock): string[] {
  const paths: string[] = [];
  for (const entry of lock.entries) {
    paths.push(entry.canonical);
    for (const host of entry.hosts) paths.push(host.path);
  }
  return paths;
}

function stateFor(files: ReadonlyMap<string, FileState>, path: string): FileState {
  return files.get(path) ?? { kind: "missing" };
}

function bytesOf(state: FileState, path: string, errors: string[]): Uint8Array | null {
  if (state.kind === "bytes") return state.bytes;
  if (state.kind === "missing") errors.push(`missing source: ${path}`);
  else if (state.kind === "symlink") errors.push(`refused symlink: ${path}`);
  else errors.push(`refused unsafe path: ${path}`);
  return null;
}

function checkDigest(path: string, expected: string, bytes: Uint8Array, errors: string[]): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) errors.push(`digest mismatch: ${path} lock ${expected} content ${actual}`);
}

function checkPointer(host: SkillHost, bytes: Uint8Array, errors: string[]): void {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const found = [...new Set(citations(text))];
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) {
    errors.push(
      found.length === 0
        ? `stale adapter reference: ${host.path} cites no canonical skill`
        : `stale adapter reference: ${host.path} cites multiple skills`,
    );
    return;
  }
  const resolved = resolveCitation(host.path, only);
  if (resolved === null) {
    errors.push(`stale adapter reference: ${host.path} resolves outside the repository`);
    return;
  }
  if (resolved !== host.target) {
    errors.push(`stale adapter reference: ${host.path} resolves to ${resolved}`);
  }
}

export function checkProvenance(
  lock: ProvenanceLock,
  files: ReadonlyMap<string, FileState>,
  discovered: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  const known = new Set(lockedPaths(lock));
  for (const path of discovered) {
    if (!known.has(path)) errors.push(`untracked skill file: ${path}`);
  }
  for (const entry of lock.entries) {
    const canonical = bytesOf(stateFor(files, entry.canonical), entry.canonical, errors);
    if (canonical !== null) checkDigest(entry.canonical, entry.sha256, canonical, errors);
    for (const host of entry.hosts) {
      const hosted = bytesOf(stateFor(files, host.path), host.path, errors);
      if (hosted === null) continue;
      checkDigest(host.path, host.sha256, hosted, errors);
      if (host.kind === "pointer") checkPointer(host, hosted, errors);
      else if (canonical !== null && sha256Hex(hosted) !== sha256Hex(canonical)) {
        errors.push(`copy diverges from canonical: ${host.path}`);
      }
    }
  }
  return errors;
}

export type AdoptionAction =
  | { readonly kind: "unchanged"; readonly path: string; readonly sha256: string }
  | {
      readonly kind: "would-restore";
      readonly path: string;
      readonly from: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

export type AdoptionPreview = {
  readonly writes: false;
  readonly destination: string;
  readonly action: AdoptionAction;
};

export type AdoptionCommand =
  | { readonly mode: "verify" }
  | { readonly mode: "dry-run"; readonly destination: string }
  | { readonly mode: "refused"; readonly reason: string };

/** A selected host only. Repair flags are refused so this command cannot write. */
export function adoptionCommand(argv: readonly string[]): AdoptionCommand {
  if (argv.includes("--apply") || argv.includes("--repair")) {
    return { mode: "refused", reason: "repair is not implemented; dry-run performs no writes" };
  }
  if (!argv.includes("--dry-run")) return { mode: "verify" };
  const index = argv.indexOf("--destination");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("-")) {
    return { mode: "refused", reason: "selected destination is required" };
  }
  return { mode: "dry-run", destination: value };
}

/**
 * Preview restoring one adopted host from its locked canonical bytes.
 * The result carries a digest and length, never file text, and never writes.
 */
export function previewAdoption(
  lock: ProvenanceLock,
  files: ReadonlyMap<string, FileState>,
  destination: string,
): AdoptionPreview {
  if (destination.trim() === "") throw new Error("selected destination is required");
  const path = assertRepoPath(destination, "destination");
  const refused = (reason: string): AdoptionPreview => ({
    writes: false,
    destination: path,
    action: { kind: "refused", path, reason },
  });
  if (containsExcluded(path)) return refused("excluded material: semantic-algos");

  let host: SkillHost | undefined;
  let entry: SkillEntry | undefined;
  for (const item of lock.entries) {
    const found = item.hosts.find((candidate) => candidate.path === path);
    if (found !== undefined) {
      host = found;
      entry = item;
      break;
    }
  }
  if (host === undefined || entry === undefined) {
    return refused(
      lock.entries.some((item) => item.canonical === path)
        ? "canonical drift is a lock failure, not a repair target"
        : "destination is not an adopted host path",
    );
  }

  const state = stateFor(files, path);
  if (state.kind === "symlink") return refused("refused symlink");
  if (state.kind === "unsafe") return refused("refused unsafe path");
  if (host.kind === "pointer") {
    if (state.kind === "bytes" && sha256Hex(state.bytes) === host.sha256) {
      return { writes: false, destination: path, action: { kind: "unchanged", path, sha256: host.sha256 } };
    }
    return refused("pointer bytes are not stored; dry-run will not invent adapter text");
  }
  if (host.sha256 !== entry.sha256) {
    return refused("copy lock digest does not match canonical; dry-run will not invent bytes");
  }

  const canonical = stateFor(files, entry.canonical);
  if (canonical.kind !== "bytes") return refused(`missing source: ${entry.canonical}`);
  if (sha256Hex(canonical.bytes) !== entry.sha256) {
    return refused("canonical digest mismatch; dry-run will not copy drifted source");
  }
  if (state.kind === "bytes" && sha256Hex(state.bytes) === host.sha256) {
    return { writes: false, destination: path, action: { kind: "unchanged", path, sha256: host.sha256 } };
  }
  return {
    writes: false,
    destination: path,
    action: {
      kind: "would-restore",
      path,
      from: entry.canonical,
      sha256: entry.sha256,
      bytes: canonical.bytes.byteLength,
    },
  };
}

export function loadSkillState(root: string, rel: string): FileState {
  try {
    assertRepoPath(rel, rel);
  } catch {
    return { kind: "unsafe" };
  }
  const absolute = join(root, rel);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (!stat.isFile()) return { kind: "missing" };
    return { kind: "bytes", bytes: new Uint8Array(readFileSync(absolute)) };
  } catch {
    return { kind: "missing" };
  }
}

export function discoverSkillFiles(root: string): { paths: string[]; errors: string[] } {
  const paths: string[] = [];
  const errors: string[] = [];
  for (const home of HOMES) {
    const absolute = join(root, home);
    let names: string[];
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        errors.push(`refused symlink: ${home}`);
        continue;
      }
      names = readdirSync(absolute);
    } catch {
      errors.push(`missing source: ${home}`);
      continue;
    }
    for (const name of names) {
      const dir = `${home}/${name}`;
      const file = `${dir}/SKILL.md`;
      try {
        assertRepoPath(file, file);
      } catch {
        errors.push(`refused unsafe path: ${file}`);
        continue;
      }
      const dirStat = lstatSync(join(root, dir));
      if (dirStat.isSymbolicLink()) {
        errors.push(`refused symlink: ${dir}`);
        continue;
      }
      const filePath = join(root, file);
      try {
        const fileStat = lstatSync(filePath);
        if (fileStat.isSymbolicLink()) {
          errors.push(`refused symlink: ${file}`);
          continue;
        }
        if (fileStat.isFile()) paths.push(file);
      } catch {
        // A skill directory without SKILL.md is not an adopted entrypoint.
      }
    }
  }
  paths.sort();
  return { paths, errors };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function readLock(root: string): ProvenanceLock {
  return parseProvenanceLock(JSON.parse(decoder.decode(readFileSync(join(root, "scripts", "skill-provenance.lock.json")))));
}

if (import.meta.main) {
  const command = adoptionCommand(process.argv.slice(2));
  if (command.mode === "refused") {
    console.error(command.reason);
    process.exitCode = 1;
  } else {
    try {
      const root = join(import.meta.dir, "..");
      const lock = readLock(root);
      const files = new Map<string, FileState>();
      for (const path of lockedPaths(lock)) files.set(path, loadSkillState(root, path));
      if (command.mode === "dry-run") {
        const preview = previewAdoption(lock, files, command.destination);
        console.log(JSON.stringify(preview));
        if (preview.action.kind === "refused") process.exitCode = 1;
      } else {
        const discovered = discoverSkillFiles(root);
        const errors = [...discovered.errors, ...checkProvenance(lock, files, discovered.paths)];
        for (const error of errors) console.error(error);
        if (errors.length > 0) process.exitCode = 1;
        else console.log("skill provenance verification passed");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "skill provenance verification failed");
      process.exitCode = 1;
    }
  }
}
