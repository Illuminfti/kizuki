/** Offline evidence inventory. No current producer set can establish release GO. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { parseBuildInfoValue } from "./stranger-proof";
import { releaseTarget } from "./release-targets";
import { statusQualification } from "./qualification";

type Profile = "rc" | "1.0";
type Status = "PASS" | "FAIL" | "MISSING" | "UNVERIFIABLE" | "NOT_IMPLEMENTED";
interface Gate { id: string; required: boolean; status: Status; scope: string; reason: string; target: string | null; evidence_sha256: string | null; }
interface ArtifactReference { producer: "kizuki.artifact-proof/v1"; target: string; directory: string; proof: string; proof_sha256: string; }
interface FixtureReference { producer: "kizuki.qualification/v1"; directory: string; manifest_sha256: string; genesis_sha256: string; samples_sha256: string; }
interface EvidenceIndex { schema: "kizuki.acceptance-evidence/v1"; candidate_source_sha: string; artifacts: ArtifactReference[]; fixture_observation: FixtureReference | null; }
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const TARGETS = ["bun-linux-x64-baseline", "bun-darwin-arm64"] as const;
const PACKAGE_FILES = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json", "SHA256SUMS"] as const;
const SUPPORTED_BUN_VERSION = readFileSync(resolve(import.meta.dir, "../.bun-version"), "utf8").trim();
const LIMITS = { index: 16384, proof: 1048576, binary: 268435456, text: 65536, journal: 67108864, depth: 32 } as const;
const JOURNEYS = ["connect-resume", "correct-belief", "revoke-purge", "retrieve-trustworthily", "import-estate-slice", "daily-loop", "useful-insight", "install-recover"] as const;
// These are acceptance obligations, never a claim that a connector is implemented.
const CONNECTORS = [
  { id: "telegram", connector_id: "kizuki.telegram", evidence: "live-account" },
  { id: "gmail", connector_id: "kizuki.gmail", evidence: "live-account" },
  { id: "google-calendar", connector_id: "kizuki.google-calendar", evidence: "live-account" },
  { id: "imap", connector_id: "kizuki.imap", evidence: "live-account" },
  { id: "ics", connector_id: "kizuki.ics", evidence: "file-import" },
  { id: "whoop", connector_id: "kizuki.whoop", evidence: "live-account" },
  { id: "x-api", connector_id: null, evidence: "live-account" },
  { id: "screenpipe", connector_id: "kizuki.screenpipe", evidence: "local-source" },
  { id: "markdown-folder", connector_id: "kizuki.markdown-folder", evidence: "file-import" },
  { id: "chatgpt-export", connector_id: "kizuki.import-chatgpt", evidence: "file-import" },
  { id: "claude-export", connector_id: "kizuki.import-claude", evidence: "file-import" },
  { id: "x-archive", connector_id: "kizuki.import-x-archive", evidence: "file-import" },
  { id: "whatsapp-export", connector_id: "kizuki.import-whatsapp", evidence: "file-import" },
  { id: "pocket", connector_id: "kizuki.import-pocket", evidence: "file-import" },
  { id: "omnivore", connector_id: "kizuki.import-omnivore", evidence: "file-import" },
] as const;
const POLICY = { schema: "kizuki.acceptance-policy/v1", supported_bun_version: SUPPORTED_BUN_VERSION, targets: TARGETS, journeys: JOURNEYS, connectors: CONNECTORS, limits: LIMITS,
  required_owner_ms: 604800000, required_estate_ms: 1209600000, unfamiliar_user_ms: 900000,
  deferred_connectors: ["composio", "whatsapp-business-api"], carry_forward: false, fixture_release_credit: false };
const VERIFIER_FILES = [".bun-version", "scripts/go-no-go.ts", "scripts/stranger-proof.ts", "scripts/release-targets.ts", "scripts/release-artifacts.ts", "scripts/qualification.ts", "packages/core/src/serve/qualification.ts", "packages/core/src/serve/receipts.ts", "packages/core/src/serve/types.ts"];

class EvidenceError extends Error { constructor(readonly reason: string) { super(reason); } }
function reject(reason: string): never { throw new EvidenceError(reason); }
function exact(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(",").sort().join()) reject("invalid-schema");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) reject("invalid-string");
  return value;
}
function digest(value: unknown, length = 64): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) reject("invalid-digest");
  return value;
}
function absolute(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path) || resolve(path) !== path) reject("noncanonical-path");
  return path;
}
/** JSON.parse alone silently accepts contradictory duplicate object keys. */
function json(bytes: Buffer): unknown {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stack: (Set<string> | null)[] = [];
  for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    const value = token[0];
    if (value === "{" || value === "[") { stack.push(value === "{" ? new Set() : null); if (stack.length > LIMITS.depth) reject("json-depth-limit"); }
    else if (value === "}" || value === "]") stack.pop();
    else {
      let after = token.index + value.length;
      while (after < raw.length && /\s/.test(raw[after]!)) after++;
      if (raw[after] === ":") {
        const keys = stack.at(-1), key = JSON.parse(value) as string;
        if (keys?.has(key)) reject("duplicate-json-key"); keys?.add(key);
      }
    }
  }
  return JSON.parse(raw) as unknown;
}

/** Reject static symlinks and detect identity changes during the read. The local
 * operator must retain exclusive custody; this is not hostile-host attestation. */
function parents(path: string) {
  const rows: { path: string; dev: bigint; ino: bigint }[] = [];
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part); const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe-path");
    rows.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return () => { for (const row of rows) { const stat = lstatSync(row.path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino) reject("path-changed"); } };
}
function read(path: string, limit: number, retain = true) {
  absolute(path); const checkParents = parents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) reject("unsafe-file-or-size");
    const size = Number(before.size), buffer = Buffer.alloc(Math.min(size + 1, 65536));
    const chunks: Buffer[] = [], state = createHash("sha256"); let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) reject("file-changed");
      const chunk = buffer.subarray(0, count); state.update(chunk); if (retain) chunks.push(Buffer.from(chunk)); offset += count;
    }
    if (readSync(fd, buffer, 0, 1, offset) !== 0) reject("file-changed");
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) reject("file-changed");
    const unchanged = () => {
      checkParents(); const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || stat.nlink !== 1n) reject("file-changed");
    };
    unchanged(); return { sha256: state.digest("hex"), bytes: retain ? Buffer.concat(chunks) : Buffer.alloc(0), unchanged };
  } finally { closeSync(fd); }
}
function parseIndex(value: unknown): EvidenceIndex {
  const row = exact(value, "schema,candidate_source_sha,artifacts,fixture_observation");
  if (row.schema !== "kizuki.acceptance-evidence/v1" || !Array.isArray(row.artifacts) || row.artifacts.length > TARGETS.length) reject("invalid-index");
  digest(row.candidate_source_sha, 40); const targets = new Set<string>();
  for (const raw of row.artifacts) {
    const ref = exact(raw, "producer,target,directory,proof,proof_sha256"), target = releaseTarget(text(ref.target));
    if (ref.producer !== "kizuki.artifact-proof/v1" || targets.has(target.target)) reject("unknown-producer-or-duplicate-target");
    targets.add(target.target); absolute(ref.directory); absolute(ref.proof); digest(ref.proof_sha256);
  }
  if (row.fixture_observation !== null) {
    const fixture = exact(row.fixture_observation, "producer,directory,manifest_sha256,genesis_sha256,samples_sha256");
    if (fixture.producer !== "kizuki.qualification/v1") reject("unknown-producer");
    absolute(fixture.directory); for (const field of ["manifest_sha256", "genesis_sha256", "samples_sha256"]) digest(fixture[field]);
  }
  return row as unknown as EvidenceIndex;
}

function expectedSteps(paths: Record<string, unknown>): [string, string[]][] {
  for (const value of Object.values(paths)) absolute(value);
  const vault = text(paths.vault), execution = dirname(vault), root = dirname(execution), restored = join(execution, "restored"), exported = join(execution, "export");
  if (vault !== join(execution, "vault") || paths.home !== join(execution, "home") || paths.config !== join(execution, "config/kizuki.toml") || paths.restored_vault !== restored || paths.executable !== join(root, "artifact/kizuki") || execution !== join(root, "execution")) reject("proof-isolation-mismatch");
  return [
    ["help", ["--help"]], ["init", ["init", vault, "--no-service"]],
    ["import", ["import", "markdown-folder", "--source", join(execution, "notes"), "--policy", join(execution, "source-policy.json"), "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", vault]],
    ["query", ["query", "Ada", "--vault", vault]], ["query-result", []],
    ["context", ["context", "--query", "Ada", "--vault", vault]], ["context-result", []],
    ["export", ["export", "--out", exported, "--vault", vault]], ["restore-verify", ["restore", "--from", exported, "--verify"]],
    ["restore", ["restore", "--from", exported, "--into", restored]],
    ["restored-query", ["query", "Ada", "--degraded", "--vault", restored]], ["restored-query-result", []],
    ["restored-context", ["context", "--query", "Ada", "--vault", restored]], ["restored-context-result", []],
  ];
}
function verifyArtifact(ref: ArtifactReference, candidate: string) {
  const files = Object.fromEntries(PACKAGE_FILES.map(name => [name, read(join(ref.directory, name), name === "kizuki" || name === "kizuki-mcp" ? LIMITS.binary : LIMITS.text, name === "BUILD.json" || name === "SHA256SUMS")]));
  const build = parseBuildInfoValue(json(files["BUILD.json"]!.bytes));
  if (build.source_sha !== candidate || build.target !== ref.target || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(build.bun_version)) reject("build-identity-mismatch");
  if (build.bun_version !== SUPPORTED_BUN_VERSION) reject("unsupported-package-bun-version");
  const checksums = PACKAGE_FILES.slice(0, -1).map(name => `${files[name]!.sha256}  ${name}`).join("\n") + "\n";
  if (files["SHA256SUMS"]!.bytes.toString("utf8") !== checksums) reject("package-checksum-mismatch");
  const proof = read(ref.proof, LIMITS.proof);
  if (proof.sha256 !== ref.proof_sha256) reject("proof-digest-mismatch");
  const row = exact(json(proof.bytes), "schema,source_sha,target,host_platform,host_arch,binary_sha256,bun_version,package_sha256,paths,steps,failures");
  const target = releaseTarget(ref.target);
  if (row.schema !== ref.producer || row.source_sha !== candidate || row.target !== target.target || row.host_platform !== target.platform || row.host_arch !== target.arch || row.bun_version !== build.bun_version || row.binary_sha256 !== files.kizuki!.sha256) reject("proof-identity-mismatch");
  const hashes = exact(row.package_sha256, PACKAGE_FILES.join());
  for (const name of PACKAGE_FILES) if (hashes[name] !== files[name]!.sha256) reject("proof-package-mismatch");
  if (!Array.isArray(row.failures) || row.failures.length !== 0) reject("proof-has-failures");
  const steps = expectedSteps(exact(row.paths, "executable,home,config,vault,restored_vault"));
  if (!Array.isArray(row.steps) || row.steps.length !== steps.length) reject("proof-step-set-mismatch");
  for (const [index, [id, args]] of steps.entries()) {
    const step = exact(row.steps[index], "id,command,exit_code,passed,timeout_ms");
    const command = args.length ? ["kizuki", ...args] : ["assert", "fixture is recalled"];
    if (step.id !== id || step.passed !== true || step.exit_code !== 0 || step.timeout_ms !== (args.length ? 30000 : 0) || JSON.stringify(step.command) !== JSON.stringify(command)) reject("proof-step-failed-or-substituted");
  }
  for (const file of Object.values(files)) file.unchanged(); proof.unchanged();
  return { target: ref.target, producer: ref.producer, producer_revision: null, scope: "automated-fixture-integrity", proof_sha256: proof.sha256,
    package_sha256: Object.fromEntries(PACKAGE_FILES.map(name => [name, files[name]!.sha256])), observation_interval: null };
}

function fixtureDiagnostic(ref: FixtureReference, index: EvidenceIndex) {
  const snapshot = () => ({ manifest: read(join(ref.directory, "manifest.json"), LIMITS.text), genesis: read(join(ref.directory, "genesis.json"), 4096), samples: read(join(ref.directory, "samples.jsonl"), LIMITS.journal, false) });
  const before = snapshot();
  if (before.manifest.sha256 !== ref.manifest_sha256 || before.genesis.sha256 !== ref.genesis_sha256 || before.samples.sha256 !== ref.samples_sha256) reject("fixture-digest-mismatch");
  // The existing loader may read only the artifact/proof explicitly in this index.
  const manifest = exact(json(before.manifest.bytes), "schema,qualification_id,policy_sha256,artifact,proof,vault,identity,profile");
  const artifact = index.artifacts.find(item => item.directory === manifest.artifact && item.proof === manifest.proof);
  if (!artifact) reject("fixture-artifact-not-indexed");
  verifyArtifact(artifact, index.candidate_source_sha);
  const result = statusQualification(ref.directory), after = snapshot();
  if (before.manifest.sha256 !== after.manifest.sha256 || before.genesis.sha256 !== after.genesis.sha256 || before.samples.sha256 !== after.samples.sha256 || result.identity.source_sha !== index.candidate_source_sha || result.identity.proof_sha256 !== artifact.proof_sha256 || result.release_qualified !== false) reject("fixture-changed-or-scope-mismatch");
  return { scope: "fixture-only", status: result.status, observed_ms: result.observed_ms, credited_ms: result.credited_ms, pending_boundary_rails: result.pending_boundary_rails, samples: result.samples, last_observed_at: result.last_observed_at,
    release_credit: false, producer_revision: null, manifest_sha256: after.manifest.sha256, genesis_sha256: after.genesis.sha256, samples_sha256: after.samples.sha256 };
}

function gates(profile: Profile): Gate[] {
  const rows: Gate[] = [];
  const add = (id: string, scope: string, status: Status = "NOT_IMPLEMENTED", reason = "trusted-producer-not-implemented", required = true, target: string | null = null) => rows.push({ id, scope, status, reason, required, target, evidence_sha256: null });
  add("evidence.index", "evidence-integrity", "MISSING", "index-missing");
  for (const target of TARGETS) {
    add(`artifact.${target}`, "automated-fixture-integrity", "MISSING", "artifact-proof-missing", true, target);
    add(`native.${target}`, "native-execution-attestation", "UNVERIFIABLE", "producer-revision-and-native-attestation-unavailable", true, target);
    add(`lifecycle.${target}`, "native-installed-service", "NOT_IMPLEMENTED", "native-lifecycle-producer-not-implemented", true, target);
  }
  add("candidate.required-checks", "exact-candidate-ci"); add("candidate.independent-review", "independent-review");
  add("candidate.current-p0-disposition", "current-head-findings", "UNVERIFIABLE", "trusted-snapshot-and-freshness-policy-unavailable");
  add("surface.capabilities-and-docs", "product-surface-inventory");
  for (const journey of JOURNEYS) add(`journey.${journey}`, "complete-product-journey");
  for (const connector of CONNECTORS) add(`connector.${connector.id}`, connector.evidence);
  add("human.unfamiliar-user", "non-author-zero-coaching");
  add("owner.seven-day-rails", "supervised-owner-observation", "NOT_IMPLEMENTED", "owner-observer-not-implemented", profile === "1.0");
  add("estate.fourteen-day-parity", "paired-estate-observation", "NOT_IMPLEMENTED", "estate-observer-not-implemented", profile === "1.0");
  add("owner.final-cutover", "owner-operational-authority", "NOT_IMPLEMENTED", "trusted-cutover-producer-not-implemented", profile === "1.0");
  add("diagnostic.fixture-observation", "fixture-only", "MISSING", "fixture-observation-not-supplied", false);
  return rows;
}

export function evaluateRelease(profile: Profile, evidencePath: string) {
  if (profile !== "rc" && profile !== "1.0") reject("unsupported-profile");
  const rows = gates(profile), evidence: ReturnType<typeof verifyArtifact>[] = [];
  const row = (id: string) => rows.find(item => item.id === id)!;
  let index: EvidenceIndex | null = null, indexDigest: string | null = null, fixture: ReturnType<typeof fixtureDiagnostic> | null = null;
  const fail = (gate: Gate, error: unknown) => { gate.status = "FAIL"; gate.reason = error instanceof EvidenceError ? error.reason : "evidence-unreadable-or-invalid"; };
  try {
    const input = read(evidencePath, LIMITS.index); indexDigest = input.sha256; index = parseIndex(json(input.bytes));
    Object.assign(row("evidence.index"), { status: "PASS", reason: "closed-index-validated", evidence_sha256: indexDigest });
  } catch (error) { fail(row("evidence.index"), error); }
  if (index) {
    for (const ref of index.artifacts) {
      const gate = row(`artifact.${ref.target}`);
      try { const verified = verifyArtifact(ref, index.candidate_source_sha); evidence.push(verified); gate.evidence_sha256 = verified.proof_sha256; gate.status = "PASS"; gate.reason = "package-and-recorded-fixture-steps-consistent"; }
      catch (error) { fail(gate, error); }
    }
    if (index.fixture_observation) {
      const gate = row("diagnostic.fixture-observation");
      try { fixture = fixtureDiagnostic(index.fixture_observation, index); gate.evidence_sha256 = fixture.samples_sha256; gate.status = "PASS"; gate.reason = "fixture-observation-validated-no-release-credit"; }
      catch (error) { fail(gate, error); }
    }
  }
  // Revision hashes describe the actual local verifier files, including policy predicates.
  const verifier = VERIFIER_FILES.map(name => ({ file: name, sha256: hash(readFileSync(resolve(import.meta.dir, "..", name))) }));
  const accepted = rows.filter(item => item.required).every(item => item.status === "PASS") && !rows.some(item => item.status === "FAIL");
  return { schema: "kizuki.acceptance-report/v1", profile, decision: accepted ? "GO" : "NO-GO", release_1_0_accepted: profile === "1.0" && accepted,
    candidate_source_sha: index?.candidate_source_sha ?? null, index_sha256: indexDigest, supported_bun_version: SUPPORTED_BUN_VERSION, policy_sha256: hash(JSON.stringify({ policy: POLICY, gates: { rc: gates("rc"), "1.0": gates("1.0") } })), verifier_sha256: hash(JSON.stringify(verifier)), verifier,
    trust_scope: "local-operator-custody; receipt consistency is not independent execution or actor attestation", connectors: CONNECTORS,
    deferred_connectors: POLICY.deferred_connectors, gates: rows, evidence, fixture_observation: fixture };
}

export function parseAcceptanceArgs(args: readonly string[]): { profile: Profile; evidence: string; out: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--profile", "--evidence", "--out"].includes(key) || !value || value.startsWith("--") || flags.has(key)) reject("invalid-arguments");
    flags.set(key, value);
  }
  const profile = flags.get("--profile");
  if (flags.size !== 3 || (profile !== "rc" && profile !== "1.0")) reject("invalid-arguments");
  return { profile, evidence: absolute(flags.get("--evidence")), out: absolute(flags.get("--out")) };
}
export function writeAcceptanceReport(path: string, report: ReturnType<typeof evaluateRelease>): void {
  absolute(path); const checkParents = parents(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(report, null, 2) + "\n"); fsyncSync(fd); checkParents(); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
if (import.meta.main) {
  try {
    const args = parseAcceptanceArgs(Bun.argv.slice(2)), report = evaluateRelease(args.profile, args.evidence);
    writeAcceptanceReport(args.out, report); process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.decision === "GO" ? 0 : 1;
  } catch { process.stderr.write("acceptance-report-failed: use --profile rc|1.0 --evidence ABSOLUTE_FILE --out ABSOLUTE_NEW_FILE\n"); process.exitCode = 2; }
}
