/** Offline transport preparation. Its manifest never authorizes distribution. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { openOwnedDirectory, OwnedDirectoryPublicationError } from "../packages/core/src/util/owned-directory";
import { parseProofJson, validateArtifactProof } from "./artifact-proof";
import { CURRENT_PACKAGE_FILES, packageFileLimit, parseBuildInfoValue, verifyPackageDirectory, type BuildInfo, type PackageFile } from "./release-artifacts";
import { BUN_DISTRIBUTION_PIN, distributionIdentity, verifyDistributionTexts } from "./release-notices";
import { absolute, digest, exact, hash, read, text } from "./release-evidence";
import { releaseTarget, type ReleaseTarget } from "./release-targets";

type CurrentBuild = Extract<BuildInfo, { schema: "kizuki.release-build/v2" }>;
export type PackageContents = Readonly<Record<PackageFile, Buffer>>;
interface FileIdentity { bytes: number; sha256: string; }
export interface DownloadTarget {
  target: ReleaseTarget["target"]; bun_version: string;
  archive: FileIdentity & { name: string };
  members: Record<PackageFile, FileIdentity>;
  artifact_proof: FileIdentity & { schema: "kizuki.artifact-proof/v3" };
  distribution: { inventory_status: "observed_complete" | "observed_with_unresolved_materials"; inventory_sha256: string };
}
export interface DownloadManifest {
  schema: "kizuki.release-download/v1"; source_sha: string;
  status: "unpublished_candidate"; release_approved: false; distribution_assessment: "not_performed";
  target_coverage: "partial" | "both_supported_targets"; targets: DownloadTarget[];
}
const TARGETS = ["bun-linux-x64-baseline", "bun-darwin-arm64"] as const;
const BLOCK = 512;
const RAW_LIMIT = CURRENT_PACKAGE_FILES.reduce((sum, name) => sum + BLOCK + Math.ceil(packageFileLimit(name) / BLOCK) * BLOCK, 1024);
export const DOWNLOAD_LIMITS = { archive: RAW_LIMIT + 1_048_576, unpacked: RAW_LIMIT, manifest: 65_536, proof: 1_048_576 } as const;
const GZIP_HEADER = Buffer.from("1f8b0800000000000203", "hex");
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(`release_download_${reason}`); }
function count(value: unknown, limit: number): number { requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit, "size"); return value; }
function fileIdentity(value: unknown, limit: number): FileIdentity { const row = exact(value, "bytes,sha256"); return { bytes: count(row.bytes, limit), sha256: digest(row.sha256) }; }
function archiveName(source: string, target: string): string { return `kizuki-${source}-${target}.tar.gz`; }
function header(name: PackageFile, size: number): Buffer {
  const result = Buffer.alloc(BLOCK);
  const octal = (offset: number, length: number, value: number) => result.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  result.write(name, 0, "ascii"); octal(100, 8, name === "kizuki" || name === "kizuki-mcp" ? 0o755 : 0o644);
  octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
  result.fill(32, 148, 156); result[156] = 48; result.write("ustar\0", 257, "ascii"); result.write("00", 263, "ascii");
  result.write([...result].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return result;
}
function inspectContents(files: PackageContents, source?: string): CurrentBuild {
  exact(files, CURRENT_PACKAGE_FILES.join(","));
  for (const name of CURRENT_PACKAGE_FILES) requireValue(Buffer.isBuffer(files[name]) && files[name].length <= packageFileLimit(name), "member_size");
  const build = parseBuildInfoValue(parseProofJson(files["BUILD.json"]));
  requireValue(build.schema === "kizuki.release-build/v2" && (source === undefined || build.source_sha === source), "build_identity");
  releaseTarget(build.target);
  const checksums = CURRENT_PACKAGE_FILES.slice(0, -1).map(name => `${hash(files[name])}  ${name}\n`).join("");
  requireValue(files.SHA256SUMS.equals(Buffer.from(checksums)), "member_checksum");
  verifyDistributionTexts(build.distribution, files.LICENSE, files["THIRD-PARTY-NOTICES.txt"]);
  return build;
}
/** Fixed flat ustar members, zero timestamps/owners, exact modes and gzip level. */
export function createPackageArchive(files: PackageContents): Buffer {
  inspectContents(files);
  const blocks: Buffer[] = [];
  for (const name of CURRENT_PACKAGE_FILES) blocks.push(header(name, files[name].length), files[name], Buffer.alloc((BLOCK - files[name].length % BLOCK) % BLOCK));
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
/** No extraction occurs. Unknown tar/gzip representations fail before publication. */
export function parsePackageArchive(archive: Uint8Array, source?: string): { files: PackageContents; build: CurrentBuild } {
  requireValue(archive.byteLength >= 18 && archive.byteLength <= DOWNLOAD_LIMITS.archive, "archive_size");
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  requireValue(bytes.subarray(0, 10).equals(GZIP_HEADER), "gzip_header");
  const announced = bytes.readUInt32LE(bytes.length - 4);
  requireValue(announced >= 9 * BLOCK && announced <= RAW_LIMIT && announced % BLOCK === 0, "unpacked_size");
  let tar: Buffer;
  try { tar = gunzipSync(bytes, { maxOutputLength: RAW_LIMIT }); } catch { throw new Error("release_download_gzip_invalid"); }
  requireValue(tar.length === announced && tar.length <= RAW_LIMIT, "unpacked_size");
  // Gunzip accepts concatenated members and some trailing data. Re-encoding the
  // exact canonical representation closes those otherwise ambiguous inputs.
  requireValue(gzipSync(tar, { level: 9 }).equals(bytes), "gzip_noncanonical");
  const entries: [PackageFile, Buffer][] = []; let offset = 0;
  for (const name of CURRENT_PACKAGE_FILES) {
    requireValue(offset + BLOCK <= tar.length, "tar_truncated");
    const raw = tar.subarray(offset, offset + BLOCK), field = raw.subarray(124, 136).toString("ascii");
    requireValue(/^[0-7]{11}\0$/.test(field), "tar_size");
    const size = Number.parseInt(field, 8); count(size, packageFileLimit(name));
    requireValue(raw.equals(header(name, size)), "tar_header");
    const start = offset + BLOCK, end = start + size, next = start + Math.ceil(size / BLOCK) * BLOCK;
    requireValue(next <= tar.length && tar.subarray(end, next).every(byte => byte === 0), "tar_padding");
    entries.push([name, tar.subarray(start, end)]); offset = next;
  }
  requireValue(tar.length === offset + BLOCK * 2 && tar.subarray(offset).every(byte => byte === 0), "tar_trailing");
  const files = Object.fromEntries(entries) as Record<PackageFile, Buffer>;
  return { files, build: inspectContents(files, source) };
}
export function parseDownloadManifest(bytes: string | Uint8Array, source: string): DownloadManifest {
  digest(source, 40); requireValue(typeof bytes === "string" ? Buffer.byteLength(bytes) <= DOWNLOAD_LIMITS.manifest : bytes.byteLength <= DOWNLOAD_LIMITS.manifest, "manifest_size");
  const row = exact(parseProofJson(bytes), "schema,source_sha,status,release_approved,distribution_assessment,target_coverage,targets");
  requireValue(row.schema === "kizuki.release-download/v1" && row.source_sha === source && row.status === "unpublished_candidate" && row.release_approved === false && row.distribution_assessment === "not_performed", "manifest_identity");
  requireValue(Array.isArray(row.targets) && row.targets.length >= 1 && row.targets.length <= TARGETS.length, "target_inventory");
  let prior = -1;
  const targets = row.targets.map((raw: unknown): DownloadTarget => {
    const targetRow = exact(raw, "target,bun_version,archive,members,artifact_proof,distribution");
    const target = releaseTarget(text(targetRow.target)).target, order = TARGETS.indexOf(target);
    requireValue(order > prior, "target_inventory"); prior = order;
    const archive = exact(targetRow.archive, "name,bytes,sha256"), artifact = exact(targetRow.artifact_proof, "schema,bytes,sha256");
    requireValue(archive.name === archiveName(source, target) && artifact.schema === "kizuki.artifact-proof/v3", "transport_identity");
    const archiveIdentity = fileIdentity({ bytes: archive.bytes, sha256: archive.sha256 }, DOWNLOAD_LIMITS.archive);
    const artifactIdentity = fileIdentity({ bytes: artifact.bytes, sha256: artifact.sha256 }, DOWNLOAD_LIMITS.proof);
    requireValue(archiveIdentity.bytes >= 18 && artifactIdentity.bytes > 0, "size");
    const memberRows = exact(targetRow.members, CURRENT_PACKAGE_FILES.join(","));
    const members = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, fileIdentity(memberRows[name], packageFileLimit(name))])) as Record<PackageFile, FileIdentity>;
    const distribution = exact(targetRow.distribution, "inventory_status,inventory_sha256");
    requireValue(distribution.inventory_status === "observed_complete" || distribution.inventory_status === "observed_with_unresolved_materials", "inventory_status");
    const bun_version = text(targetRow.bun_version, 32); requireValue(bun_version === BUN_DISTRIBUTION_PIN.version, "runtime_identity");
    return { target, bun_version, archive: { name: archiveName(source, target), ...archiveIdentity }, members,
      artifact_proof: { schema: "kizuki.artifact-proof/v3", ...artifactIdentity },
      distribution: { inventory_status: distribution.inventory_status, inventory_sha256: digest(distribution.inventory_sha256) } };
  });
  const target_coverage = targets.length === TARGETS.length ? "both_supported_targets" : "partial";
  requireValue(row.target_coverage === target_coverage, "target_coverage");
  return { schema: "kizuki.release-download/v1", source_sha: source, status: "unpublished_candidate", release_approved: false, distribution_assessment: "not_performed", target_coverage, targets };
}
function bindPackageProof(files: PackageContents, proof: Uint8Array, source: string) {
  const build = inspectContents(files, source), target = releaseTarget(build.target).target;
  const members = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, { bytes: files[name].length, sha256: hash(files[name]) }])) as Record<PackageFile, FileIdentity>;
  const package_sha256 = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, members[name].sha256])) as Record<PackageFile, string>;
  const checked = validateArtifactProof(parseProofJson(proof), { source_sha: source, target, bun_version: build.bun_version, package_sha256, build });
  requireValue(checked.schema === "kizuki.artifact-proof/v3" && checked.engine.status === "PASS", "artifact_proof");
  return { build, target, members };
}
function describeTarget(bound: ReturnType<typeof bindPackageProof>, proof: Uint8Array, archive: Uint8Array): DownloadTarget {
  const { build, target, members } = bound;
  return { target, bun_version: build.bun_version, archive: { name: archiveName(build.source_sha, target), bytes: archive.byteLength, sha256: hash(archive) }, members,
    artifact_proof: { schema: "kizuki.artifact-proof/v3", bytes: proof.byteLength, sha256: hash(proof) },
    distribution: { inventory_status: build.distribution.inventory_status, inventory_sha256: distributionIdentity(build.distribution).inventory_sha256 } };
}
/** Rebind a retained archive to the caller's source and exact V3 proof. */
export function verifyDownloadArchive(manifest: DownloadManifest, target: string, archive: Uint8Array, proof: Uint8Array): void {
  const parsed = parseDownloadManifest(JSON.stringify(manifest), manifest.source_sha), row = parsed.targets.find(item => item.target === target);
  requireValue(row !== undefined, "target_missing");
  requireValue(archive.byteLength === row.archive.bytes && hash(archive) === row.archive.sha256 && proof.byteLength === row.artifact_proof.bytes && hash(proof) === row.artifact_proof.sha256, "transport_hash");
  const unpacked = parsePackageArchive(archive, parsed.source_sha);
  requireValue(JSON.stringify(describeTarget(bindPackageProof(unpacked.files, proof, parsed.source_sha), proof, archive)) === JSON.stringify(row), "manifest_binding");
}
export interface DownloadPreparation { source_sha: string; packages: readonly { directory: string; proof: string }[]; output: string; }
export function prepareReleaseDownload(input: DownloadPreparation): DownloadManifest {
  const source = digest(input.source_sha, 40), output = absolute(input.output);
  requireValue(input.packages.length >= 1 && input.packages.length <= TARGETS.length, "target_inventory");
  const prepared = input.packages.map(item => {
    const directory = absolute(item.directory), buildFile = read(join(directory, "BUILD.json"), packageFileLimit("BUILD.json"));
    const build = parseBuildInfoValue(parseProofJson(buildFile.bytes));
    requireValue(build.schema === "kizuki.release-build/v2", "build_identity"); verifyPackageDirectory(directory, build);
    const reads = CURRENT_PACKAGE_FILES.map(name => name === "BUILD.json" ? buildFile : read(join(directory, name), packageFileLimit(name, build)));
    const files = Object.fromEntries(CURRENT_PACKAGE_FILES.map((name, index) => [name, reads[index]!.bytes])) as Record<PackageFile, Buffer>;
    const proof = read(absolute(item.proof), DOWNLOAD_LIMITS.proof);
    // Admit the existing package/proof before constructing a transport wrapper.
    const bound = bindPackageProof(files, proof.bytes, source);
    const archive = createPackageArchive(files), row = describeTarget(bound, proof.bytes, archive);
    const checks = [...reads.map(value => value.unchanged), proof.unchanged];
    return { archive, row, proof: proof.bytes, unchanged: () => { for (const check of checks) check(); verifyPackageDirectory(directory, build); } };
  }).sort((a, b) => TARGETS.indexOf(a.row.target) - TARGETS.indexOf(b.row.target));
  const manifest = parseDownloadManifest(JSON.stringify({ schema: "kizuki.release-download/v1", source_sha: source, status: "unpublished_candidate", release_approved: false,
    distribution_assessment: "not_performed", target_coverage: prepared.length === TARGETS.length ? "both_supported_targets" : "partial", targets: prepared.map(item => item.row) }), source);
  // The independently parsed archive is checked before even creating output.
  for (const item of prepared) { verifyDownloadArchive(manifest, item.row.target, item.archive, item.proof); item.unchanged(); }
  const parent = openOwnedDirectory(dirname(output)), stage = `.kizuki-download-${randomUUID()}`;
  let identity: ReturnType<typeof parent.createStaging> | null = null, published = false, cleanupSafe = true;
  try {
    identity = parent.createStaging(stage);
    const outputChecks: (() => void)[] = [];
    const write = (name: string, bytes: Uint8Array) => {
      parent.assertCurrent(); const current = parent.childIdentity(stage);
      requireValue(current !== null && identity !== null && current.dev === identity.dev && current.ino === identity.ino, "staging_identity");
      const fd = openSync(join(dirname(output), stage, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      const retained = read(join(dirname(output), stage, name), bytes.byteLength);
      requireValue(retained.sha256 === hash(bytes), "output_changed"); outputChecks.push(retained.unchanged);
    };
    for (const item of prepared) write(item.row.archive.name, item.archive);
    write("download-manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    const expectedNames = [...prepared.map(item => item.row.archive.name), "download-manifest.json"].sort();
    requireValue(JSON.stringify(readdirSync(join(dirname(output), stage)).sort()) === JSON.stringify(expectedNames), "output_members");
    for (const item of prepared) item.unchanged();
    for (const check of outputChecks) check();
    parent.publishStaging(stage, identity, basename(output), null); published = true;
    return manifest;
  } catch (error) { if (error instanceof OwnedDirectoryPublicationError) cleanupSafe = error.cleanup_safe; throw error; }
  finally { try { if (identity !== null && !published && cleanupSafe) parent.removeTree(stage, identity); } finally { parent.close(); } }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2), packages: { directory: string; proof: string }[] = [];
    requireValue(args.length >= 8 && args[0] === "--source" && args[2] === "--out" && (args.length - 4) % 4 === 0, "arguments");
    for (let i = 4; i < args.length; i += 4) { requireValue(args[i] === "--artifact" && args[i + 2] === "--proof" && args[i + 1] && args[i + 3], "arguments"); packages.push({ directory: resolve(args[i + 1]!), proof: resolve(args[i + 3]!) }); }
    const result = prepareReleaseDownload({ source_sha: args[1]!, output: resolve(args[3]!), packages });
    console.log(JSON.stringify({ status: result.status, release_approved: false, target_coverage: result.target_coverage, targets: result.targets.map(item => item.target) }));
  } catch (error) { console.error(error instanceof Error ? error.message : "release_download_failed"); process.exitCode = 1; }
}
