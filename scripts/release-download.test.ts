import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import * as zlib from "node:zlib";
import { artifactProofSteps, SQLITE_ENGINE_POLICY } from "./artifact-proof";
import { checksumManifest, CURRENT_PACKAGE_FILES, type PackageFile } from "./release-artifacts";
import { distributionIdentity } from "./release-notices";
import { writePackageFixture } from "./release-package-fixture";
import { hash } from "./release-evidence";
import { createPackageArchive, DOWNLOAD_LIMITS, parseDownloadManifest, parsePackageArchive, prepareReleaseDownload, verifyDownloadArchive, type PackageContents } from "./release-download";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "kizuki-download-test-"))); directories.push(path); return path; }
function fixture(target = "bun-linux-x64-baseline", complete = false) {
  const root = directory(), packageDir = join(root, "package"); fs.mkdirSync(packageDir, { mode: 0o700 });
  const build = writePackageFixture(packageDir, "a".repeat(40), target, complete);
  const files = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, fs.readFileSync(join(packageDir, name))])) as Record<PackageFile, Buffer>;
  const package_sha256 = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, hash(files[name])]));
  const execution = "/tmp/kizuki-download-schema-fixture/execution";
  const paths = { executable: "/tmp/kizuki-download-schema-fixture/artifact/kizuki", home: `${execution}/home`, config: `${execution}/config/kizuki.toml`, vault: `${execution}/vault`, restored_vault: `${execution}/restored` };
  const accepted = SQLITE_ENGINE_POLICY.accepted[0]!;
  const runtime = { schema: "kizuki.sqlite-runtime/v1", bun_version: build.bun_version, sqlite_version: accepted.sqlite_version, sqlite_source_id: accepted.sqlite_source_id };
  const proof = { schema: "kizuki.artifact-proof/v3", source_sha: build.source_sha, target, bun_version: build.bun_version, package_sha256,
    binary_sha256: package_sha256.kizuki, host_platform: target.includes("darwin") ? "darwin" : "linux", host_arch: target.includes("darwin") ? "arm64" : "x64", host_kernel_release: "synthetic-schema-fixture",
    paths, steps: artifactProofSteps("kizuki.artifact-proof/v3", paths).map(step => ({ ...step, exit_code: 0, passed: true })), failures: [],
    distribution_identity: distributionIdentity(build.distribution), engine_observations: {
      kizuki: { executable_sha256: package_sha256.kizuki, runtime, exit_code: 0, doctor_status: "ok" },
      kizuki_mcp: { executable_sha256: package_sha256["kizuki-mcp"], runtime, exit_code: 0, mcp_is_error: false },
    } };
  const proofFile = join(root, "proof.json"); fs.writeFileSync(proofFile, JSON.stringify(proof));
  return { root, files, build, proof, proofFile, packageDir, output: join(root, "prepared") };
}
function prepare(f: ReturnType<typeof fixture>) { return prepareReleaseDownload({ source_sha: f.build.source_sha, packages: [{ directory: f.packageDir, proof: f.proofFile }], output: f.output }); }
function changedArchive(change: (tar: Buffer) => Buffer | void) {
  const f = fixture(), tar = gunzipSync(createPackageArchive(f.files)), archive = gzipSync(change(tar) ?? tar, { level: 9 });
  archive[9] = 3; return archive;
}
function refreshHeader(tar: Buffer, offset = 0) { tar.fill(32, offset + 148, offset + 156); const sum = [...tar.subarray(offset, offset + 512)].reduce((n, b) => n + b, 0); tar.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148, 8, "ascii"); }

test("canonical current package roundtrip is deterministic and byte exact", () => {
  const f = fixture(), first = createPackageArchive(f.files), second = createPackageArchive(f.files), parsed = parsePackageArchive(first, f.build.source_sha);
  expect(first.equals(second)).toBe(true); expect(parsed.build).toEqual(f.build);
  for (const name of CURRENT_PACKAGE_FILES) expect(parsed.files[name].equals(f.files[name])).toBe(true);
});
test("compressor host metadata is canonicalized while foreign input headers are refused", () => {
  const f = fixture(), original = zlib.gzipSync;
  console.log(JSON.stringify({ schema: "kizuki.gzip-encoder-observation/v1", platform: process.platform,
    bun_version: Bun.version, raw_header: original(Buffer.from("synthetic gzip fixture"), { level: 9 }).subarray(0, 10).toString("hex") }));
  const wanted = createPackageArchive(f.files);
  for (const os of [3, 19, 255]) {
    const encoder = spyOn(zlib, "gzipSync").mockImplementation((...args: Parameters<typeof gzipSync>) => {
      const bytes = original(...args); bytes[9] = os; return bytes;
    });
    try {
      const archive = createPackageArchive(f.files);
      expect(archive.equals(wanted)).toBe(true);
      expect(parsePackageArchive(archive).build).toEqual(f.build);
    } finally { encoder.mockRestore(); }
  }
  const foreign = Buffer.from(wanted); foreign[9] = 19;
  expect(() => parsePackageArchive(foreign)).toThrow("release_download_gzip_header");
  const encoder = spyOn(zlib, "gzipSync").mockImplementation((...args: Parameters<typeof gzipSync>) => {
    const bytes = original(...args); bytes[3] = 4; return bytes;
  });
  try { expect(() => createPackageArchive(f.files)).toThrow("release_download_encoder_header"); }
  finally { encoder.mockRestore(); }
});
for (const [name, mutate] of [
  ["traversal", (tar: Buffer) => { tar.fill(0, 0, 100); tar.write("../kizuki"); refreshHeader(tar); }],
  ["absolute name", (tar: Buffer) => { tar.fill(0, 0, 100); tar.write("/kizuki"); refreshHeader(tar); }],
  ["symlink", (tar: Buffer) => { tar[156] = 50; tar.write("outside", 157); refreshHeader(tar); }],
  ["hardlink", (tar: Buffer) => { tar[156] = 49; tar.write("outside", 157); refreshHeader(tar); }],
  ["PAX header", (tar: Buffer) => { tar[156] = 120; refreshHeader(tar); }],
  ["GNU header", (tar: Buffer) => { tar[156] = 76; refreshHeader(tar); }],
  ["directory", (tar: Buffer) => { tar[156] = 53; refreshHeader(tar); }],
  ["device", (tar: Buffer) => { tar[156] = 51; refreshHeader(tar); }],
  ["duplicate member", (tar: Buffer) => { tar.fill(0, 1024, 1124); tar.write("kizuki", 1024); refreshHeader(tar, 1024); }],
  ["missing member", (tar: Buffer) => Buffer.concat([tar.subarray(0, 1024), tar.subarray(2048)])],
  ["extra member", (tar: Buffer) => Buffer.concat([tar.subarray(0, tar.length - 1024), tar.subarray(0, 1024), Buffer.alloc(1024)])],
  ["trailing zero blocks", (tar: Buffer) => Buffer.concat([tar, Buffer.alloc(512)])],
  ["truncated tar", (tar: Buffer) => tar.subarray(0, tar.length - 512)],
  ["nonzero padding", (tar: Buffer) => { tar[1023] = 1; }],
  ["mode", (tar: Buffer) => { tar.write("0000644\0", 100, 8); refreshHeader(tar); }],
  ["owner", (tar: Buffer) => { tar.write("0000001\0", 108, 8); refreshHeader(tar); }],
  ["oversized member", (tar: Buffer) => { tar.write((268435457).toString(8).padStart(11, "0") + "\0", 124, 12); refreshHeader(tar); }],
  ["base-256 size", (tar: Buffer) => { tar[124] = 128; refreshHeader(tar); }],
  ["altered member hash", (tar: Buffer) => { tar[512] = 42; }],
] satisfies [string, (tar: Buffer) => Buffer | void][]) test(`archive refuses ${name}`, () => { expect(() => parsePackageArchive(changedArchive(mutate))).toThrow(); });
test("gzip refuses corruption, truncation, concatenation, padding and announced expansion", () => {
  const valid = createPackageArchive(fixture().files), corrupt = Buffer.from(valid); corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
  const oversized = Buffer.from(valid); oversized.writeUInt32LE(DOWNLOAD_LIMITS.unpacked + 512, oversized.length - 4);
  for (const archive of [corrupt, valid.subarray(0, valid.length - 9), Buffer.concat([valid, valid]), Buffer.concat([valid, Buffer.alloc(8)]), oversized]) expect(() => parsePackageArchive(archive)).toThrow();
});
test("preparation preserves seven members and unresolved notices without release credit", () => {
  const f = fixture(), manifest = prepare(f), archive = fs.readFileSync(join(f.output, manifest.targets[0]!.archive.name));
  expect(manifest).toMatchObject({ source_sha: f.build.source_sha, status: "unpublished_candidate", release_approved: false, distribution_assessment: "not_performed", target_coverage: "partial" });
  expect(manifest.targets[0]!.distribution.inventory_status).toBe("observed_with_unresolved_materials");
  verifyDownloadArchive(manifest, f.build.target, archive, fs.readFileSync(f.proofFile));
  expect(fs.readdirSync(f.output).sort()).toEqual([manifest.targets[0]!.archive.name, "download-manifest.json"].sort());
  const replay = { ...f, output: join(f.root, "second") }, again = prepare(replay);
  expect(again).toEqual(manifest); expect(fs.readFileSync(join(replay.output, again.targets[0]!.archive.name)).equals(archive)).toBe(true);
});
test("both supported targets remain unpublished even with complete schema inventories", () => {
  const linux = fixture("bun-linux-x64-baseline", true), mac = fixture("bun-darwin-arm64", true);
  const manifest = prepareReleaseDownload({ source_sha: linux.build.source_sha, output: linux.output, packages: [{ directory: mac.packageDir, proof: mac.proofFile }, { directory: linux.packageDir, proof: linux.proofFile }] });
  expect(manifest.target_coverage).toBe("both_supported_targets"); expect(manifest.targets.map(row => row.target)).toEqual(["bun-linux-x64-baseline", "bun-darwin-arm64"]);
  expect(manifest.release_approved).toBe(false); expect(manifest.distribution_assessment).toBe("not_performed");
});
test("a corrupted proof or changed source fails before output creation", () => {
  const f = fixture(); f.proof.package_sha256.kizuki = "0".repeat(64); fs.writeFileSync(f.proofFile, JSON.stringify(f.proof));
  expect(() => prepare(f)).toThrow(); expect(fs.existsSync(f.output)).toBe(false);
  expect(() => prepareReleaseDownload({ source_sha: "b".repeat(40), packages: [{ directory: f.packageDir, proof: f.proofFile }], output: f.output })).toThrow();
});
test("internal checksum replacement cannot substitute bytes already bound by V3", () => {
  const f = fixture(), manifest = prepare(f), row = manifest.targets[0]!;
  fs.appendFileSync(join(f.packageDir, "kizuki"), "Changed synthetic fixture\n"); fs.writeFileSync(join(f.packageDir, "SHA256SUMS"), checksumManifest(f.packageDir, CURRENT_PACKAGE_FILES.slice(0, -1)));
  const files = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, fs.readFileSync(join(f.packageDir, name))])) as Record<PackageFile, Buffer>;
  const archive = createPackageArchive(files); row.archive.bytes = archive.length; row.archive.sha256 = hash(archive);
  for (const name of CURRENT_PACKAGE_FILES) row.members[name] = { bytes: files[name].length, sha256: hash(files[name]) };
  expect(() => verifyDownloadArchive(manifest, row.target, archive, fs.readFileSync(f.proofFile))).toThrow();
});
test("manifest is closed, source-pinned, complete about its target coverage and never approves release", () => {
  const f = fixture(), valid = prepare(f);
  for (const modified of [{ ...valid, release_approved: true }, { ...valid, target_coverage: "both_supported_targets" }, { ...valid, source_sha: "b".repeat(40) }, { ...valid, extra: true }, { ...valid, targets: [valid.targets[0], valid.targets[0]] }]) expect(() => parseDownloadManifest(JSON.stringify(modified), f.build.source_sha)).toThrow();
  expect(() => parseDownloadManifest('{"schema":1,"schema":2}', f.build.source_sha)).toThrow();
  const modified = structuredClone(valid); modified.targets[0]!.archive.name = "../outside.tar.gz";
  expect(() => parseDownloadManifest(JSON.stringify(modified), f.build.source_sha)).toThrow();
});
test("transport hash and reported inventory disposition must match actual archive/proof", () => {
  const f = fixture(), manifest = prepare(f), row = manifest.targets[0]!, archive = fs.readFileSync(join(f.output, row.archive.name));
  const proof = fs.readFileSync(f.proofFile), changed = Buffer.from(archive); changed[12] = changed[12]! ^ 1;
  expect(() => verifyDownloadArchive(manifest, row.target, changed, proof)).toThrow("transport_hash");
  row.distribution.inventory_status = "observed_complete";
  expect(() => verifyDownloadArchive(manifest, row.target, archive, proof)).toThrow("manifest_binding");
});
test("occupied or aliased output is preserved and not overwritten", () => {
  const f = fixture(); fs.mkdirSync(f.output); fs.writeFileSync(join(f.output, "owned.txt"), "preserved");
  expect(() => prepare(f)).toThrow(); expect(fs.readFileSync(join(f.output, "owned.txt"), "utf8")).toBe("preserved");
  const alias = join(f.root, "alias"); fs.symlinkSync(f.output, alias);
  expect(() => prepare({ ...f, output: alias })).toThrow(); expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
});
test("input change after admission prevents final publication", () => {
  const f = fixture(), original = fs.openSync; let changed = false;
  const spy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (!changed && typeof args[0] === "string" && args[0].includes(".kizuki-download-") && args[0].endsWith(".tar.gz")) { changed = true; fs.appendFileSync(join(f.packageDir, "README.txt"), "changed during write\n"); }
    return original(...args);
  });
  try { expect(() => prepare(f)).toThrow("file-changed"); expect(changed).toBe(true); expect(fs.existsSync(f.output)).toBe(false); }
  finally { spy.mockRestore(); }
});
test("earlier output mutation prevents final publication", () => {
  const f = fixture(), original = fs.openSync; let changed = false;
  const spy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (!changed && typeof args[0] === "string" && args[0].includes(".kizuki-download-") && args[0].endsWith("download-manifest.json")) {
      changed = true;
      fs.appendFileSync(args[0].replace("download-manifest.json", `kizuki-${f.build.source_sha}-${f.build.target}.tar.gz`), "changed after readback");
    }
    return original(...args);
  });
  try { expect(() => prepare(f)).toThrow("file-changed"); expect(changed).toBe(true); expect(fs.existsSync(f.output)).toBe(false); }
  finally { spy.mockRestore(); }
});
test("archive creator refuses extra members and legacy packages", () => {
  const f = fixture(); expect(() => createPackageArchive({ ...f.files, unexpected: Buffer.from("x") } as PackageContents)).toThrow();
  const legacy = { schema: "kizuki.release-build/v1", source_sha: f.build.source_sha, target: f.build.target, bun_version: f.build.bun_version };
  expect(() => createPackageArchive({ ...f.files, "BUILD.json": Buffer.from(JSON.stringify(legacy)) })).toThrow();
});
