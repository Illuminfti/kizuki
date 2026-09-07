import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DISTRIBUTION_LIMITS = { components: 256, notices_per_component: 16, notices_bytes: 4 * 1024 * 1024, build_bytes: 512 * 1024 } as const;
export const BUN_DISTRIBUTION_PIN = {
  version: "1.3.14", revision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
  notice_sha256: "2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741",
} as const;
const REASONS = ["license_text_missing", "embedded_component_inventory_incomplete", "embedded_license_texts_incomplete", "corresponding_source_unassessed", "relink_material_unassessed"] as const;
type Reason = typeof REASONS[number];
type Binary = "kizuki" | "kizuki-mcp";
type Source = { kind: "npm"; name: string; version: string; integrity: string }
  | { kind: "repository"; url: string; revision: string; sha256: string }
  | { kind: "package_asset"; name: string; version: string; integrity: string; path: string; sha256: string };
interface Notice { source_path: string; source_sha256: string; source_offset: number; byte_length: number; notice_offset: number; sha256: string; }
export interface DistributionComponent {
  kind: "npm" | "runtime" | "asset" | "vendored"; name: string; version_or_revision: string | null;
  declared_license: string | null; source: Source; binaries: Binary[]; input_identity_sha256: string;
  notice_texts: Notice[]; unresolved: Reason[];
}
export interface PackageDistribution {
  schema: "kizuki.package-distribution/v1"; bun_revision: string; bun_lock_sha256: string;
  project_license_sha256: string; third_party_notices_sha256: string; components: DistributionComponent[];
  inventory_status: "observed_with_unresolved_materials" | "observed_complete";
  distribution_assessment: "not_performed";
}
export const distributionHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function fail(): never { throw new Error("invalid package distribution identity"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(",").sort().join()) fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function digest(value: unknown, length = 64): string { const v = string(value, length); if (!new RegExp(`^[a-f0-9]{${length}}$`).test(v)) fail(); return v; }
function path(value: unknown): string { const v = string(value); if (isAbsolute(v) || v.includes("\\") || v.split("/").some(x => !x || x === "." || x === "..")) fail(); return v; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > DISTRIBUTION_LIMITS.notices_bytes) fail(); return value as number; }
function ordered(values: string[]): void { if (values.some((v, i) => i > 0 && v <= values[i - 1]!)) fail(); }

/** Closed material identity only. No field represents permission to distribute. */
export function parsePackageDistribution(value: unknown): PackageDistribution {
  const row = object(value, "schema,bun_revision,bun_lock_sha256,project_license_sha256,third_party_notices_sha256,components,inventory_status,distribution_assessment");
  if (row.schema !== "kizuki.package-distribution/v1" || row.bun_revision !== BUN_DISTRIBUTION_PIN.revision || row.distribution_assessment !== "not_performed") fail();
  for (const key of ["bun_lock_sha256", "project_license_sha256", "third_party_notices_sha256"]) digest(row[key]);
  if (!Array.isArray(row.components) || row.components.length < 1 || row.components.length > DISTRIBUTION_LIMITS.components) fail();
  const identities: string[] = [], intervals: [number, number][] = [];
  let unresolved = false, runtimes = 0;
  for (const raw of row.components) {
    const c = object(raw, "kind,name,version_or_revision,declared_license,source,binaries,input_identity_sha256,notice_texts,unresolved");
    if (!["npm", "runtime", "asset", "vendored"].includes(c.kind as string)) fail();
    string(c.name, 512); if (c.version_or_revision !== null) string(c.version_or_revision, 128);
    if (c.declared_license !== null) string(c.declared_license, 512);
    identities.push(`${c.kind}:${c.name}@${c.version_or_revision}`); digest(c.input_identity_sha256);
    if (!Array.isArray(c.binaries) || c.binaries.length < 1 || c.binaries.length > 2 || c.binaries.some(x => x !== "kizuki" && x !== "kizuki-mcp")) fail();
    ordered(c.binaries);
    const source = c.source as Record<string, unknown>;
    if (source?.kind === "npm" || source?.kind === "package_asset") {
      object(source, source.kind === "npm" ? "kind,name,version,integrity" : "kind,name,version,integrity,path,sha256");
      string(source.name, 512); string(source.version, 128);
      if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(string(source.integrity, 128))) fail();
      if (source.kind === "npm" && (c.kind !== "npm" || source.name !== c.name || source.version !== c.version_or_revision)) fail();
      if (source.kind === "package_asset") { if (c.kind !== "asset") fail(); path(source.path); digest(source.sha256); }
    } else if (source?.kind === "repository") {
      object(source, "kind,url,revision,sha256"); digest(source.revision, 40); digest(source.sha256);
      const url = new URL(string(source.url)); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail();
      if (c.kind !== "runtime" && c.kind !== "vendored") fail();
    } else fail();
    if (!Array.isArray(c.notice_texts) || c.notice_texts.length > DISTRIBUTION_LIMITS.notices_per_component) fail();
    const noticeNames: string[] = [];
    for (const rawNotice of c.notice_texts) {
      const n = object(rawNotice, "source_path,source_sha256,source_offset,byte_length,notice_offset,sha256");
      noticeNames.push(path(n.source_path)); digest(n.source_sha256); digest(n.sha256);
      const bytes = integer(n.byte_length), offset = integer(n.notice_offset); integer(n.source_offset);
      if (bytes === 0 || offset + bytes > DISTRIBUTION_LIMITS.notices_bytes || (n.source_offset as number) + bytes > DISTRIBUTION_LIMITS.notices_bytes) fail();
      intervals.push([offset, offset + bytes]);
    }
    ordered(noticeNames);
    if (!Array.isArray(c.unresolved) || c.unresolved.some(x => !REASONS.includes(x))) fail();
    ordered(c.unresolved); unresolved ||= c.unresolved.length > 0;
    if (c.kind === "runtime") {
      runtimes++;
      if (c.name !== "Bun" || c.version_or_revision !== BUN_DISTRIBUTION_PIN.revision || source.kind !== "repository" ||
          source.revision !== BUN_DISTRIBUTION_PIN.revision || source.sha256 !== BUN_DISTRIBUTION_PIN.notice_sha256 ||
          !c.notice_texts.some((n: Notice) => n.sha256 === BUN_DISTRIBUTION_PIN.notice_sha256)) fail();
    }
  }
  ordered(identities); intervals.sort((a, b) => a[0] - b[0]);
  if (runtimes !== 1 || intervals.some((span, i) => i > 0 && span[0] < intervals[i - 1]![1]) ||
      row.inventory_status !== (unresolved ? "observed_with_unresolved_materials" : "observed_complete")) fail();
  return value as PackageDistribution;
}

export function distributionIdentity(distribution: PackageDistribution) {
  // Normalise property order before hashing; array order is already canonical.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
  return { build_schema: "kizuki.release-build/v2" as const, inventory_sha256: distributionHash(JSON.stringify(canonical(parsePackageDistribution(distribution)))) };
}

export function verifyDistributionTexts(distribution: PackageDistribution, license: Uint8Array, notices: Uint8Array): void {
  parsePackageDistribution(distribution);
  if (license.byteLength > 65_536 || notices.byteLength > DISTRIBUTION_LIMITS.notices_bytes ||
      distributionHash(license) !== distribution.project_license_sha256 || distributionHash(notices) !== distribution.third_party_notices_sha256) fail();
  const decoder = new TextDecoder("utf-8", { fatal: true }); decoder.decode(license); decoder.decode(notices);
  for (const c of distribution.components) for (const n of c.notice_texts) {
    if (n.notice_offset + n.byte_length > notices.byteLength || distributionHash(notices.subarray(n.notice_offset, n.notice_offset + n.byte_length)) !== n.sha256) fail();
  }
}

function localBytes(root: string, name: string, limit = DISTRIBUTION_LIMITS.notices_bytes): Buffer {
  const full = resolve(root, name), base = realpathSync(root);
  if (!realpathSync(full).startsWith(`${base}/`)) fail();
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail();
  return readFileSync(full);
}
type Metafile = NonNullable<Awaited<ReturnType<typeof Bun.build>>["metafile"]>;

/** Uses the metafiles from the same two native compiles that produced the package. */
export function createPackageDistribution(root: string, revision: string, metafiles: Record<Binary, Metafile>) {
  if (Bun.version !== BUN_DISTRIBUTION_PIN.version || Bun.revision !== BUN_DISTRIBUTION_PIN.revision) fail();
  const lockBytes = localBytes(root, "bun.lock"), lock = Bun.JSON5.parse(lockBytes.toString()) as { packages: Record<string, unknown> };
  const components: DistributionComponent[] = [], chunks: Buffer[] = [];
  let length = 0;
  const append = (bytes: Buffer) => { const offset = length; length += bytes.length; if (length > DISTRIBUTION_LIMITS.notices_bytes) fail(); chunks.push(bytes); return offset; };
  append(Buffer.from("Third-party material inventory for this unpublished Kizuki candidate.\nObserved declarations and supplied texts are not a distribution assessment.\n\n"));
  const entries = new Map<string, { folder: string; inputs: Map<string, string>; binaries: Set<Binary> }>();
  const assetEntries = new Map<string, { owner: string; bytes: Buffer; binaries: Set<Binary> }>();
  for (const binary of ["kizuki", "kizuki-mcp"] as const) {
    const meta = metafiles[binary];
    if (!meta || !meta.inputs || !meta.outputs || Object.keys(meta.inputs).length > 16_384) fail();
    for (const output of Object.values(meta.outputs)) for (const [input, contribution] of Object.entries(output.inputs)) {
      if (!Number.isSafeInteger(contribution.bytesInOutput) || contribution.bytesInOutput < 0) fail();
      if (contribution.bytesInOutput === 0 || !input.includes("node_modules/")) continue;
      const full = resolve(root, input); if (!full.startsWith(`${resolve(root)}/`)) fail();
      let folder = dirname(full), manifestBytes: Buffer, manifest: { name: string; version: string };
      // Nested package.json can contain only a module type. Its enclosing named,
      // versioned package owns the input; module metadata is not a package identity.
      while (true) {
        if (lstatSafe(join(folder, "package.json"))) {
          manifestBytes = localBytes(root, relative(root, join(folder, "package.json")), 65_536);
          const candidate = JSON.parse(manifestBytes.toString());
          if (typeof candidate.name === "string" && typeof candidate.version === "string") { manifest = candidate; break; }
        }
        const next = dirname(folder); if (next === folder || !next.startsWith(`${resolve(root)}/node_modules`)) fail(); folder = next;
      }
      const identity = `${manifest.name}@${manifest.version}`;
      const entry = entries.get(identity) ?? { folder, inputs: new Map(), binaries: new Set() };
      if (entry.folder !== folder) fail(); entry.binaries.add(binary);
      entry.inputs.set("package.json", distributionHash(manifestBytes));
      entry.inputs.set(relative(folder, full), distributionHash(localBytes(root, relative(root, full), 64 * 1024 * 1024)));
      entries.set(identity, entry);
      if (/\.(wasm|data|tar\.gz)$/.test(input)) {
        const asset = assetEntries.get(input) ?? { owner: identity, bytes: localBytes(root, input, 64 * 1024 * 1024), binaries: new Set() };
        asset.binaries.add(binary); assetEntries.set(input, asset);
      }
    }
  }
  const locked = (name: string, version: string): Source & { kind: "npm" } => {
    const candidates = Object.values(lock.packages).filter((x): x is unknown[] => Array.isArray(x) && x[0] === `${name}@${version}`);
    const integrities = new Set(candidates.map(x => x.at(-1)));
    if (integrities.size !== 1 || typeof [...integrities][0] !== "string") fail();
    return { kind: "npm", name, version, integrity: [...integrities][0] as string };
  };
  const addTexts = (component: DistributionComponent, texts: { name: string; source: Buffer; start?: number; length?: number }[]) => {
    append(Buffer.from(`Component: ${component.name} (${component.version_or_revision ?? "unknown"})\nDeclared license: ${component.declared_license ?? "unknown"}\nUnresolved: ${component.unresolved.join(", ") || "none recorded"}\n\n`));
    for (const text of texts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const start = text.start ?? 0, bytes = text.source.subarray(start, text.length === undefined ? undefined : start + text.length);
      append(Buffer.from(`Source: ${text.name}\n`)); const offset = append(bytes); append(Buffer.from("\n\n"));
      component.notice_texts.push({ source_path: text.name, source_sha256: distributionHash(text.source), source_offset: start, byte_length: bytes.length, notice_offset: offset, sha256: distributionHash(bytes) });
    }
    components.push(component);
  };
  for (const [identity, entry] of [...entries].sort()) {
    const manifest = JSON.parse(localBytes(root, relative(root, join(entry.folder, "package.json")), 65_536).toString()) as { name: string; version: string; license?: unknown };
    const source = locked(manifest.name, manifest.version), declared = typeof manifest.license === "string" ? manifest.license : null;
    const texts: { name: string; source: Buffer; start?: number; length?: number }[] = readdirSync(entry.folder).filter(name => /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/i.test(name)).map(name => ({ name, source: localBytes(root, relative(root, join(entry.folder, name))) }));
    let partial = false;
    if (identity === "imurmurhash@0.1.4" && texts.length === 0) {
      const source = localBytes(root, relative(root, join(entry.folder, "README.md"))), start = source.indexOf("License (MIT)");
      if (start < 0 || !source.subarray(start).includes("Permission is hereby granted")) fail(); texts.push({ name: "README.md", source, start });
    }
    if (identity === "store2@2.14.4" && texts.length === 0) {
      const source = localBytes(root, relative(root, join(entry.folder, "dist/store2.js"))), end = source.indexOf("*/");
      if (end < 0 || end > 4096) fail(); texts.push({ name: "dist/store2.js", source, length: end + 2 }); partial = true;
    }
    const unresolved: Reason[] = [];
    if (texts.length === 0 || partial) unresolved.push("license_text_missing");
    if (declared === null || /GPL/i.test(declared)) unresolved.push("corresponding_source_unassessed");
    if (manifest.name.startsWith("@electric-sql/pglite")) unresolved.push("embedded_component_inventory_incomplete", "embedded_license_texts_incomplete");
    addTexts({ kind: "npm", name: manifest.name, version_or_revision: manifest.version, declared_license: declared, source,
      binaries: [...entry.binaries].sort(), input_identity_sha256: distributionHash(JSON.stringify([...entry.inputs].sort())), notice_texts: [], unresolved: unresolved.sort() }, texts);
  }
  for (const [input, entry] of [...assetEntries].sort()) {
    const owner = components.find(c => c.kind === "npm" && `${c.name}@${c.version_or_revision}` === entry.owner)!;
    const source = owner.source as Source & { kind: "npm" }, assetPath = relative(entries.get(entry.owner)!.folder, resolve(root, input));
    addTexts({ kind: "asset", name: `${source.name}/${assetPath}`, version_or_revision: source.version, declared_license: null,
      source: { ...source, kind: "package_asset", path: assetPath, sha256: distributionHash(entry.bytes) }, binaries: [...entry.binaries].sort(),
      input_identity_sha256: distributionHash(entry.bytes), notice_texts: [], unresolved: ["embedded_component_inventory_incomplete", "embedded_license_texts_incomplete"] }, []);
  }
  const bunNotice = localBytes(root, "scripts/release-notices/Bun-1.3.14-LICENSE.md");
  if (distributionHash(bunNotice) !== BUN_DISTRIBUTION_PIN.notice_sha256) fail();
  addTexts({ kind: "runtime", name: "Bun", version_or_revision: BUN_DISTRIBUTION_PIN.revision, declared_license: "MIT; embedded components have separate declarations",
    source: { kind: "repository", url: `https://github.com/oven-sh/bun/blob/${BUN_DISTRIBUTION_PIN.revision}/LICENSE.md`, revision: BUN_DISTRIBUTION_PIN.revision, sha256: distributionHash(bunNotice) },
    binaries: ["kizuki", "kizuki-mcp"], input_identity_sha256: distributionHash(BUN_DISTRIBUTION_PIN.revision), notice_texts: [],
    unresolved: ["corresponding_source_unassessed", "embedded_component_inventory_incomplete", "embedded_license_texts_incomplete", "relink_material_unassessed"] }, [{ name: "LICENSE.md", source: bunNotice }]);
  const vendorFiles = ["LICENSE", "NOTICE"].map(name => ({ name, source: localBytes(root, `packages/retrieval-pg/vendor/${name}`) }));
  addTexts({ kind: "vendored", name: "Kizuki retrieval recipe", version_or_revision: revision, declared_license: "MIT",
    source: { kind: "repository", url: `https://github.com/Illuminfti/kizuki/tree/${revision}/packages/retrieval-pg/vendor`, revision, sha256: distributionHash(Buffer.concat(vendorFiles.map(x => x.source))) },
    binaries: ["kizuki", "kizuki-mcp"], input_identity_sha256: distributionHash(Buffer.concat(vendorFiles.map(x => x.source))), notice_texts: [], unresolved: [] }, vendorFiles);
  components.sort((a, b) => { const x = `${a.kind}:${a.name}@${a.version_or_revision}`, y = `${b.kind}:${b.name}@${b.version_or_revision}`; return x < y ? -1 : x > y ? 1 : 0; });
  const license = localBytes(root, "LICENSE", 65_536), notices = Buffer.concat(chunks);
  const distribution = parsePackageDistribution({ schema: "kizuki.package-distribution/v1", bun_revision: BUN_DISTRIBUTION_PIN.revision,
    bun_lock_sha256: distributionHash(lockBytes), project_license_sha256: distributionHash(license), third_party_notices_sha256: distributionHash(notices),
    components, inventory_status: "observed_with_unresolved_materials", distribution_assessment: "not_performed" });
  verifyDistributionTexts(distribution, license, notices);
  return { distribution, license, notices };
}
function lstatSafe(path: string): boolean { try { return lstatSync(path).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
