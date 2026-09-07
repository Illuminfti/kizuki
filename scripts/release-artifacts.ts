import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseProofJson } from "./proof-json";
import { BUN_DISTRIBUTION_PIN, DISTRIBUTION_LIMITS, distributionIdentity, parsePackageDistribution, verifyDistributionTexts, type PackageDistribution } from "./release-notices";

export const LEGACY_PACKAGE_FILES = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json", "SHA256SUMS"] as const;
export const CURRENT_PACKAGE_FILES = ["kizuki", "kizuki-mcp", "README.txt", "LICENSE", "THIRD-PARTY-NOTICES.txt", "BUILD.json", "SHA256SUMS"] as const;
export type PackageFile = typeof CURRENT_PACKAGE_FILES[number];
interface BuildBase { source_sha: string; target: string; bun_version: string; }
export type BuildInfo = (BuildBase & { schema: "kizuki.release-build/v1" }) |
  (BuildBase & { schema: "kizuki.release-build/v2"; distribution: PackageDistribution });
export function packageFiles(build: BuildInfo): readonly PackageFile[] { return build.schema === "kizuki.release-build/v1" ? LEGACY_PACKAGE_FILES : CURRENT_PACKAGE_FILES; }
export function packageFileLimit(name: PackageFile, build?: BuildInfo): number {
  if (name === "kizuki" || name === "kizuki-mcp") return 268_435_456;
  if (name === "THIRD-PARTY-NOTICES.txt") return DISTRIBUTION_LIMITS.notices_bytes;
  if (name === "BUILD.json" && build?.schema !== "kizuki.release-build/v1") return DISTRIBUTION_LIMITS.build_bytes;
  return 65_536;
}
export function parseBuildInfoValue(value: unknown): BuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release BUILD.json has an invalid shape");
  const row = value as Record<string, unknown>, v2 = row.schema === "kizuki.release-build/v2";
  if ((!v2 && row.schema !== "kizuki.release-build/v1") ||
      Object.keys(row).sort().join() !== (v2 ? "bun_version,distribution,schema,source_sha,target" : "bun_version,schema,source_sha,target") ||
      typeof row.source_sha !== "string" || !/^[a-f0-9]{40}$/.test(row.source_sha) || typeof row.target !== "string" || typeof row.bun_version !== "string") {
    throw new Error("release BUILD.json has an invalid shape");
  }
  if (v2) {
    if (row.bun_version !== BUN_DISTRIBUTION_PIN.version) throw new Error("release BUILD.json runtime mismatch");
    parsePackageDistribution(row.distribution);
  }
  return value as BuildInfo;
}
export function parseBuildInfo(path: string): BuildInfo {
  requireRegularFile(path);
  if (lstatSync(path).size > DISTRIBUTION_LIMITS.build_bytes) throw new Error("release BUILD.json exceeds bounds");
  return parseBuildInfoValue(parseProofJson(readFileSync(path)));
}
export function verifyPackageDirectory(directory: string, build: BuildInfo): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(directory).sort().join() !== [...packageFiles(build)].sort().join()) throw new Error("release package member mismatch");
  for (const name of packageFiles(build)) {
    const file = join(directory, name); requireRegularFile(file);
    if (lstatSync(file).size > packageFileLimit(name, build)) throw new Error("release package file exceeds bounds");
  }
  const actual = parseBuildInfo(join(directory, "BUILD.json"));
  if (actual.schema !== build.schema || actual.source_sha !== build.source_sha || actual.target !== build.target || actual.bun_version !== build.bun_version ||
      (actual.schema === "kizuki.release-build/v2" && build.schema === "kizuki.release-build/v2" && distributionIdentity(actual.distribution).inventory_sha256 !== distributionIdentity(build.distribution).inventory_sha256)) throw new Error("release BUILD.json identity changed");
  verifyChecksumManifest(directory, packageFiles(build).slice(0, -1));
  if (build.schema === "kizuki.release-build/v2" && readFileSync(join(directory, "SHA256SUMS"), "utf8") !== checksumManifest(directory, CURRENT_PACKAGE_FILES.slice(0, -1))) throw new Error("release checksum verification failed");
  if (build.schema === "kizuki.release-build/v2") verifyDistributionTexts(build.distribution,
    readFileSync(join(directory, "LICENSE")), readFileSync(join(directory, "THIRD-PARTY-NOTICES.txt")));
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Creates a release-owned directory only when no untrusted path is present. */
export function ensureReleaseDirectory(path: string): void {
  if (absent(path)) {
    mkdirSync(path, { mode: 0o700 });
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe release directory: ${path}`);
  }
}

/** Refuse to overwrite an artifact or follow a symlink while hashing it. */
export function requireRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`unsafe release artifact: ${path}`);
  }
}

export function checksumManifest(directory: string, names: readonly string[]): string {
  return names.map((name) => {
    const path = join(directory, name);
    requireRegularFile(path);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${digest}  ${name}`;
  }).join("\n") + "\n";
}

export function verifyChecksumManifest(directory: string, names: readonly string[]): void {
  const manifestPath = join(directory, "SHA256SUMS");
  requireRegularFile(manifestPath);
  const expected = checksumManifest(directory, names).trim();
  const actual = readFileSync(manifestPath, "utf8").trim();
  if (actual !== expected) throw new Error("release checksum verification failed");
}

export function requireAbsent(path: string): void {
  if (!absent(path)) throw new Error(`refusing to overwrite release artifact: ${basename(path)}`);
}
