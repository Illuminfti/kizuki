/** Offline evidence inventory. No current producer set can establish release GO. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EvidenceError, reject, exact, text, digest, absolute, json, read, hash, publishEvidence, PACKAGE_FILES, SUPPORTED_BUN_VERSION, verifyPackage } from "./native-proof-evidence";
import { releaseTarget } from "./release-targets";
import { statusQualification } from "./qualification";
import { RECOVERY_SUBGATES } from "./recovery-proof-recipe";
import { GENERATOR_FILES, validateRecoveryReceipt, verifiedRecoveryCredit } from "./recovery-proof-receipt";

type Profile = "rc" | "1.0";
type Status = "PASS" | "FAIL" | "MISSING" | "UNVERIFIABLE" | "NOT_IMPLEMENTED";
interface Gate { id: string; required: boolean; status: Status; scope: string; reason: string; target: string | null; evidence_sha256: string | null; }
interface ArtifactReference { producer: "kizuki.artifact-proof/v1"; target: string; directory: string; proof: string; proof_sha256: string; }
interface FixtureReference { producer: "kizuki.qualification/v1"; directory: string; manifest_sha256: string; genesis_sha256: string; samples_sha256: string; }
interface RecoveryReference { producer: "kizuki.native-recovery-proof/v2"; target: string; path: string; receipt_sha256: string }
interface EvidenceIndex { schema: "kizuki.acceptance-evidence/v1" | "kizuki.acceptance-evidence/v2"; candidate_source_sha: string; artifacts: ArtifactReference[]; fixture_observation: FixtureReference | null; recovery?: RecoveryReference[] }
const TARGETS = ["bun-linux-x64-baseline", "bun-darwin-arm64"] as const;
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
const POLICY = { schema: "kizuki.acceptance-policy/v2", supported_bun_version: SUPPORTED_BUN_VERSION, targets: TARGETS, journeys: JOURNEYS, connectors: CONNECTORS, limits: LIMITS,
  required_owner_ms: 604800000, required_estate_ms: 1209600000, unfamiliar_user_ms: 900000,
  deferred_connectors: ["composio", "whatsapp-business-api"], carry_forward: false, fixture_release_credit: false, recovery_subgates: RECOVERY_SUBGATES };
const VERIFIER_FILES = [...new Set([...GENERATOR_FILES, ".bun-version", "scripts/go-no-go.ts", "scripts/native-proof-evidence.ts", "scripts/stranger-proof.ts", "scripts/release-targets.ts", "scripts/release-artifacts.ts", "scripts/qualification.ts", "packages/core/src/serve/qualification.ts", "packages/core/src/serve/receipts.ts", "packages/core/src/serve/types.ts"])];

function parseIndex(value: unknown): EvidenceIndex {
  const version2 = value !== null && typeof value === "object" && "schema" in value && value.schema === "kizuki.acceptance-evidence/v2";
  const row = exact(value, version2 ? "schema,candidate_source_sha,artifacts,fixture_observation,recovery" : "schema,candidate_source_sha,artifacts,fixture_observation");
  if ((!version2 && row.schema !== "kizuki.acceptance-evidence/v1") || !Array.isArray(row.artifacts) || row.artifacts.length > TARGETS.length) reject("invalid-index");
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
  if (version2) {
    if (!Array.isArray(row.recovery) || row.recovery.length > TARGETS.length) reject("invalid-recovery-index");
    const recovered = new Set<string>();
    for (const raw of row.recovery) {
      const ref = exact(raw, "producer,target,path,receipt_sha256"), target = releaseTarget(text(ref.target));
      if (ref.producer !== "kizuki.native-recovery-proof/v2" || recovered.has(target.target)) reject("unknown-producer-or-duplicate-target");
      recovered.add(target.target); absolute(ref.path); digest(ref.receipt_sha256);
    }
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
  const artifact = verifyPackage(ref.directory, candidate, ref.target), build = artifact.build;
  const proof = read(ref.proof, LIMITS.proof);
  if (proof.sha256 !== ref.proof_sha256) reject("proof-digest-mismatch");
  const row = exact(json(proof.bytes), "schema,source_sha,target,host_platform,host_arch,binary_sha256,bun_version,package_sha256,paths,steps,failures");
  const target = releaseTarget(ref.target);
  if (row.schema !== ref.producer || row.source_sha !== candidate || row.target !== target.target || row.host_platform !== target.platform || row.host_arch !== target.arch || row.bun_version !== build.bun_version || row.binary_sha256 !== artifact.package_sha256.kizuki) reject("proof-identity-mismatch");
  const hashes = exact(row.package_sha256, PACKAGE_FILES.join());
  for (const name of PACKAGE_FILES) if (hashes[name] !== artifact.package_sha256[name]) reject("proof-package-mismatch");
  if (!Array.isArray(row.failures) || row.failures.length !== 0) reject("proof-has-failures");
  const steps = expectedSteps(exact(row.paths, "executable,home,config,vault,restored_vault"));
  if (!Array.isArray(row.steps) || row.steps.length !== steps.length) reject("proof-step-set-mismatch");
  for (const [index, [id, args]] of steps.entries()) {
    const step = exact(row.steps[index], "id,command,exit_code,passed,timeout_ms");
    const command = args.length ? ["kizuki", ...args] : ["assert", "fixture is recalled"];
    if (step.id !== id || step.passed !== true || step.exit_code !== 0 || step.timeout_ms !== (args.length ? 30000 : 0) || JSON.stringify(step.command) !== JSON.stringify(command)) reject("proof-step-failed-or-substituted");
  }
  artifact.unchanged(); proof.unchanged();
  return { target: ref.target, producer: ref.producer, producer_revision: null, scope: "automated-fixture-integrity", proof_sha256: proof.sha256,
    package_sha256: artifact.package_sha256, observation_interval: null };
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
    for (const subgate of RECOVERY_SUBGATES) add(`automated.${subgate}.${target}`, "synthetic-native-observation", "MISSING", "recovery-proof-missing", true, target);
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
  const rows = gates(profile), evidence: ReturnType<typeof verifyArtifact>[] = [], recoveryEvidence: ReturnType<typeof verifiedRecoveryCredit>[] = [];
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
    for (const ref of index.recovery ?? []) {
      const automated = RECOVERY_SUBGATES.map(subgate => row(`automated.${subgate}.${ref.target}`));
      try {
        const indexedArtifact = index.artifacts.find(artifact => artifact.target === ref.target);
        if (!indexedArtifact || row(`artifact.${ref.target}`).status !== "PASS") reject("recovery-artifact-prerequisite-missing");
        const input = read(ref.path, LIMITS.proof);
        if (input.sha256 !== ref.receipt_sha256) reject("recovery-digest-mismatch");
        const artifact = verifyPackage(indexedArtifact.directory, index.candidate_source_sha, ref.target);
        const receipt = validateRecoveryReceipt(json(input.bytes), artifact); input.unchanged();
        const verified = verifiedRecoveryCredit(receipt, input.sha256); recoveryEvidence.push(verified);
        for (const gate of automated) Object.assign(gate, { status: "PASS", reason: "fixed-synthetic-recovery-observations-verified", evidence_sha256: verified.receipt_sha256 });
      } catch (error) { for (const gate of automated) fail(gate, error); }
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
  return { schema: "kizuki.acceptance-report/v2", profile, decision: accepted ? "GO" : "NO-GO", release_1_0_accepted: profile === "1.0" && accepted,
    candidate_source_sha: index?.candidate_source_sha ?? null, index_sha256: indexDigest, supported_bun_version: SUPPORTED_BUN_VERSION, policy_sha256: hash(JSON.stringify({ policy: POLICY, gates: { rc: gates("rc"), "1.0": gates("1.0") } })), verifier_sha256: hash(JSON.stringify(verifier)), verifier,
    trust_scope: "local-operator-custody; receipt consistency is not independent execution or actor attestation", connectors: CONNECTORS,
    deferred_connectors: POLICY.deferred_connectors, gates: rows, evidence, recovery_evidence: recoveryEvidence, fixture_observation: fixture };
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
  publishEvidence(path, report);
}
if (import.meta.main) {
  try {
    const args = parseAcceptanceArgs(Bun.argv.slice(2)), report = evaluateRelease(args.profile, args.evidence);
    writeAcceptanceReport(args.out, report); process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.decision === "GO" ? 0 : 1;
  } catch (error) {
    const published = error instanceof EvidenceError && error.reason.startsWith("published-report-");
    process.stderr.write(published ? `${error.reason}: complete report exists at the requested output; do not retry publication to that path\n`
      : "acceptance-report-failed: use --profile rc|1.0 --evidence ABSOLUTE_FILE --out ABSOLUTE_NEW_FILE\n");
    process.exitCode = 2;
  }
}
