/** Byte verification only. This module cannot grant a release gate. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CURRENT_PACKAGE_FILES, packageFileLimit, parseBuildInfoValue, verifyPackageDirectory } from "./release-artifacts";
import { validateArtifactProof, PROOF_JSON_LIMITS } from "./artifact-proof";
import { absolute, EVALUATOR_ROOT, parents, read, reject } from "./release-evidence";
import { parseProofJson } from "./proof-json";

export const GITHUB_ARCHIVE_LIMIT = 300_000_000;
export function verifyGithubNativeArchive(archive: string, output: string, target: string, candidate: string, bunVersion: string) {
  absolute(archive); absolute(output);
  const held = read(archive, GITHUB_ARCHIVE_LIMIT, false), checkParent = parents(output);
  let members: unknown;
  try {
    const result = execFileSync("python3", ["-I", "-S", join(EVALUATOR_ROOT, "scripts/github-artifact-archive.py"), archive, output, target], {
      timeout: 60_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"],
    });
    members = parseProofJson(result);
  } catch { reject("github-artifact-archive-refused"); }
  held.unchanged(); checkParent();
  const directory = join(output, "package");
  const buildFile = read(join(directory, "BUILD.json"), packageFileLimit("BUILD.json"));
  const build = parseBuildInfoValue(parseProofJson(buildFile.bytes));
  if (build.schema !== "kizuki.release-build/v2" || build.source_sha !== candidate || build.target !== target || build.bun_version !== bunVersion) reject("github-artifact-build-mismatch");
  verifyPackageDirectory(directory, build);
  const files = CURRENT_PACKAGE_FILES.map(name => ({ name, file: read(join(directory, name), packageFileLimit(name, build), false) }));
  const package_sha256 = Object.fromEntries(files.map(({ name, file }) => [name, file.sha256])) as Record<typeof CURRENT_PACKAGE_FILES[number], string>;
  const proof = read(join(output, "artifact-proof.json"), PROOF_JSON_LIMITS.bytes);
  const validated = validateArtifactProof(parseProofJson(proof.bytes), { source_sha: candidate, target, bun_version: bunVersion, package_sha256, build });
  if (validated.schema !== "kizuki.artifact-proof/v3" || validated.engine.status !== "PASS") reject("github-artifact-proof-unqualified");
  const lifecycle = read(join(output, "lifecycle-diagnostic.json"), 1_048_576, false);
  for (const { file } of files) file.unchanged();
  buildFile.unchanged(); proof.unchanged(); lifecycle.unchanged(); held.unchanged(); checkParent();
  return { archive_sha256: held.sha256, target, package_sha256, proof_sha256: proof.sha256, build,
    members, lifecycle: { sha256: lifecycle.sha256, release_credit: false, reason: "current-receipt-does-not-prove-release-upgrade-and-reboot" } };
}
