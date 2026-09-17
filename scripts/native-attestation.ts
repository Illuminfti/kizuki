/** Native-host execution attestation. This is not lifecycle or macOS qualification. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { release as kernelRelease } from "node:os";
import { dirname, join } from "node:path";
import { packageFiles, parseBuildInfo, verifyPackageDirectory } from "./release-artifacts";
import {
  EVALUATOR_ROOT, EVIDENCE_LIMITS, EvidenceError, NATIVE_ATTESTATION_PRODUCER, NATIVE_ATTESTATION_PRODUCER_FILES,
  absolute, digest, evaluateNativeAttestationReceipt, hash, inspectOptionalVerifier, parents, producerRevision, read, reject,
} from "./release-evidence";
import type { GateReceiptReference } from "./release-evidence";
import { releaseTarget, requireNativeHost } from "./release-targets";

export interface NativeAttestationArgs { candidate: string; artifact: string; out: string }
export function parseNativeAttestationArgs(args: readonly string[]): NativeAttestationArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--candidate", "--artifact", "--out"].includes(key) || !value || value.startsWith("--") || flags.has(key)) reject("invalid-arguments");
    flags.set(key, value);
  }
  if (flags.size !== 3) reject("invalid-arguments");
  return { candidate: digest(flags.get("--candidate"), 40), artifact: absolute(flags.get("--artifact")), out: absolute(flags.get("--out")) };
}

function publish(path: string, bytes: string) {
  const checkParents = parents(path), temporary = mkdtempSync(join(dirname(path), ".kizuki-native-attestation-publish-"));
  const pending = join(temporary, "receipt.json");
  let cleanupFailed = false;
  try {
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    checkParents();
    linkSync(pending, path);
  } finally {
    try { rmSync(pending, { force: true }); } catch { cleanupFailed = true; }
    try { rmdirSync(temporary); } catch { cleanupFailed = true; }
  }
  try {
    checkParents();
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { reject("published-receipt-durability-unconfirmed"); }
  if (cleanupFailed) reject("published-receipt-cleanup-failed");
}

function producerFiles(root: string) {
  return NATIVE_ATTESTATION_PRODUCER_FILES.map(path => {
    const entry = inspectOptionalVerifier(root, path);
    if (entry.status !== "PRESENT" || entry.sha256 === null) reject("producer-revision-and-native-attestation-unavailable");
    return { path, sha256: entry.sha256 };
  });
}

export function runNativeAttestation(args: NativeAttestationArgs): GateReceiptReference {
  const candidate = digest(args.candidate, 40), artifact = absolute(args.artifact), out = absolute(args.out);
  if (out === EVALUATOR_ROOT || out.startsWith(`${EVALUATOR_ROOT}/`) || artifact === EVALUATOR_ROOT || artifact.startsWith(`${EVALUATOR_ROOT}/`)) {
    reject("output-inside-checkout");
  }
  parents(out)(); parents(artifact)();
  const bun_version = readFileSync(join(EVALUATOR_ROOT, ".bun-version"), "utf8").trim();
  let build;
  try { build = parseBuildInfo(join(artifact, "BUILD.json")); }
  catch { reject("invalid-schema"); }
  if (build.source_sha !== candidate) reject("candidate-mismatch");
  if (build.bun_version !== bun_version) reject("unsupported-bun-version");
  const target = releaseTarget(build.target);
  try { requireNativeHost(target); } catch { reject("cannot-certify-native-execution"); }
  try { verifyPackageDirectory(artifact, build); } catch { reject("package-checksum-mismatch"); }
  const names = packageFiles(build);
  const files = Object.fromEntries(names.map(name => [name, read(join(artifact, name), name === "kizuki" || name === "kizuki-mcp" ? 268_435_456 : 1_048_576)]));
  const package_sha256 = Object.fromEntries(names.map(name => [name, files[name]!.sha256]));
  const spawn = (path: string, args: readonly string[]) => {
    try {
      const child = Bun.spawnSync([path, ...args], {
        cwd: artifact, stdout: "pipe", stderr: "pipe", timeout: 5_000, killSignal: "SIGKILL", env: {},
      });
      return child.signalCode ? null : child;
    } catch {
      return null;
    }
  };
  const child = spawn(join(artifact, "kizuki"), ["--help"]);
  if (child === null || child.exitCode !== 0) reject("native-execution-failed");
  const mcp = spawn(join(artifact, "kizuki-mcp"), []);
  if (mcp === null || mcp.exitCode === null) reject("native-mcp-execution-failed");
  const producer_files = producerFiles(EVALUATOR_ROOT);
  const receipt = {
    schema: NATIVE_ATTESTATION_PRODUCER,
    identity: {
      candidate_source_sha: candidate, producer: NATIVE_ATTESTATION_PRODUCER, producer_revision: producerRevision(producer_files),
      producer_files: producer_files.map(item => item.path), source_class: "native-host-attestation", actor_class: "automated-producer",
      attempt_id: randomUUID(), recorded_at: new Date().toISOString(),
    },
    target: target.target, host_platform: target.platform, host_arch: target.arch, host_kernel_release: kernelRelease(),
    bun_version, execution_class: "native-host", binary_sha256: package_sha256.kizuki, package_sha256,
    argv: ["kizuki", "--help"], exit_code: child.exitCode, stdout_sha256: hash(child.stdout),
    mcp_argv: ["kizuki-mcp"], mcp_exit_code: mcp.exitCode, mcp_stderr_sha256: hash(mcp.stderr), outcome: "pass", failures: [],
  };
  for (const file of Object.values(files)) file.unchanged();
  if (evaluateNativeAttestationReceipt(receipt, {
    candidate_source_sha: candidate, target: target.target, producer_files: [...NATIVE_ATTESTATION_PRODUCER_FILES],
    producer_revision: producerRevision(producer_files), package_sha256, evaluator_platform: process.platform,
    evaluator_arch: process.arch, bun_version,
  }).status !== "PASS") reject("native-attestation-disagreement");
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > EVIDENCE_LIMITS.family_receipt) reject("receipt-byte-bound");
  publish(out, bytes);
  try {
    const published = read(out, EVIDENCE_LIMITS.family_receipt);
    if (published.sha256 !== hash(bytes)) reject("file-changed");
    published.unchanged();
    return { producer: NATIVE_ATTESTATION_PRODUCER, gate_id: `native.${target.target}`, target: target.target, path: out, sha256: published.sha256 };
  } catch { reject("published-receipt-verification-failed"); }
}

if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(runNativeAttestation(parseNativeAttestationArgs(Bun.argv.slice(2)))) + "\n"); }
  catch (error) {
    const reason = error instanceof EvidenceError ? error.reason : "native-attestation-failed";
    process.stderr.write(reason.startsWith("published-receipt-")
      ? `${reason}: output was published; retain it for inspection and do not retry that path\n`
      : `${reason}: no native execution receipt credited\n`);
    process.exitCode = 2;
  }
}
