/** Synthetic schema fixture only; it never represents an observed compiled input graph. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_DISTRIBUTION_PIN, distributionHash, type PackageDistribution } from "./release-notices";
import { checksumManifest, CURRENT_PACKAGE_FILES, type BuildInfo } from "./release-artifacts";

export function distributionFixture(complete = false): { distribution: PackageDistribution; license: Buffer; notices: Buffer } {
  const license = Buffer.from("Synthetic project license. Schema fixture only.\n");
  const notices = readFileSync(join(import.meta.dir, "release-notices/Bun-1.3.14-LICENSE.md"));
  const distribution: PackageDistribution = {
    schema: "kizuki.package-distribution/v1", bun_revision: BUN_DISTRIBUTION_PIN.revision,
    bun_lock_sha256: "a".repeat(64), project_license_sha256: distributionHash(license), third_party_notices_sha256: distributionHash(notices),
    components: [{ kind: "runtime", name: "Bun", version_or_revision: BUN_DISTRIBUTION_PIN.revision,
      declared_license: "Synthetic schema fixture; no compilation observed", source: { kind: "repository", revision: BUN_DISTRIBUTION_PIN.revision,
        url: `https://github.com/oven-sh/bun/blob/${BUN_DISTRIBUTION_PIN.revision}/LICENSE.md`, sha256: distributionHash(notices) },
      binaries: ["kizuki", "kizuki-mcp"], input_identity_sha256: "b".repeat(64), notice_texts: [{ source_path: "LICENSE.md", source_sha256: distributionHash(notices),
        source_offset: 0, byte_length: notices.length, notice_offset: 0, sha256: distributionHash(notices) }],
      unresolved: complete ? [] : ["embedded_component_inventory_incomplete", "embedded_license_texts_incomplete"],
    }], inventory_status: complete ? "observed_complete" : "observed_with_unresolved_materials", distribution_assessment: "not_performed",
  };
  return { distribution, license, notices };
}
export function writePackageFixture(directory: string, source = "a".repeat(40), target = "bun-linux-x64-baseline", complete = false): BuildInfo & { schema: "kizuki.release-build/v2" } {
  const material = distributionFixture(complete);
  for (const name of ["kizuki", "kizuki-mcp", "README.txt"]) writeFileSync(join(directory, name), `Synthetic ${name}. Never executed.\n`);
  writeFileSync(join(directory, "LICENSE"), material.license); writeFileSync(join(directory, "THIRD-PARTY-NOTICES.txt"), material.notices);
  const build = { schema: "kizuki.release-build/v2" as const, source_sha: source, target, bun_version: BUN_DISTRIBUTION_PIN.version, distribution: material.distribution };
  writeFileSync(join(directory, "BUILD.json"), JSON.stringify(build));
  writeFileSync(join(directory, "SHA256SUMS"), checksumManifest(directory, CURRENT_PACKAGE_FILES.slice(0, -1)));
  return build;
}
