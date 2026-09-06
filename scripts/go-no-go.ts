/** Offline evidence inventory. No current producer set can establish release GO. */
import { closeSync, constants, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseBuildInfoValue } from "./stranger-proof";
import { releaseTarget } from "./release-targets";
import { statusQualification } from "./qualification";
import { ARTIFACT_PACKAGE_FILES as PACKAGE_FILES, ArtifactProofError, PROOF_JSON_LIMITS, SQLITE_ENGINE_POLICY, parseProofJson as json, validateArtifactProof } from "./artifact-proof";
import type { ArtifactPackageFile, ArtifactProofSchema } from "./artifact-proof";
import {
  CAPABILITY_PROOF_FILE, CONNECTORS, EVIDENCE_LIMITS, EVALUATOR_ROOT, EvidenceError, JOURNEYS, SURFACE_GATE, SURFACE_PRODUCER, TARGETS,
  absolute, consumeSurfaceReceipt, digest, exact, gateReceiptMappingError, hash, inspectOptionalVerifier, parseGateReceipts, parents, read, reject, surfaceProducerActive, text,
} from "./release-evidence";
import type { GateReceiptReference } from "./release-evidence";

type Profile = "rc" | "1.0";
type Status = "PASS" | "FAIL" | "MISSING" | "UNVERIFIABLE" | "NOT_IMPLEMENTED";
interface Gate { id: string; required: boolean; status: Status; scope: string; reason: string; target: string | null; evidence_sha256: string | null; }
interface ArtifactReference { producer: ArtifactProofSchema; target: string; directory: string; proof: string; proof_sha256: string; }
interface FixtureReference { producer: "kizuki.qualification/v1"; directory: string; manifest_sha256: string; genesis_sha256: string; samples_sha256: string; }
interface EvidenceIndex {
  schema: "kizuki.acceptance-evidence/v1" | "kizuki.acceptance-evidence/v2" | "kizuki.acceptance-evidence/v3";
  candidate_source_sha: string; artifacts: ArtifactReference[]; fixture_observation: FixtureReference | null;
  gate_receipts: GateReceiptReference[];
}
const SUPPORTED_BUN_VERSION = readFileSync(resolve(import.meta.dir, "../.bun-version"), "utf8").trim();
const LIMITS = { index: EVIDENCE_LIMITS.index, index_v3: EVIDENCE_LIMITS.index_v3, family_receipt: EVIDENCE_LIMITS.family_receipt, journey_connector_receipt: EVIDENCE_LIMITS.journey_connector_receipt, proof: PROOF_JSON_LIMITS.bytes, binary: 268435456, text: 65536, journal: 67108864, depth: PROOF_JSON_LIMITS.depth } as const;
const POLICY = { schema: "kizuki.acceptance-policy/v2", sqlite_engine: SQLITE_ENGINE_POLICY, supported_bun_version: SUPPORTED_BUN_VERSION, targets: TARGETS, journeys: JOURNEYS, connectors: CONNECTORS, limits: LIMITS,
  post_ready_observation_ms: { owner: 604800000, estate: 1209600000 }, unfamiliar_user_ms: 900000,
  deferred_connectors: ["composio", "whatsapp-business-api"], carry_forward: false, fixture_release_credit: false };
const VERIFIER_FILES = [".bun-version", "scripts/go-no-go.ts", "scripts/release-evidence.ts", "scripts/artifact-proof.ts", "scripts/artifact-engine.ts", "packages/core/src/ledger/runtime.ts", "scripts/stranger-proof.ts", "scripts/release-targets.ts", "scripts/release-artifacts.ts", "scripts/qualification.ts", "packages/core/src/serve/qualification.ts", "packages/core/src/serve/receipts.ts", "packages/core/src/serve/types.ts"];

function parseIndex(value: unknown, bytes: number): EvidenceIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid-index");
  const v3 = (value as { schema?: unknown }).schema === "kizuki.acceptance-evidence/v3";
  if (bytes > (v3 ? LIMITS.index_v3 : LIMITS.index)) reject("unsafe-file-or-size");
  const row = exact(value, v3 ? "schema,candidate_source_sha,artifacts,fixture_observation,gate_receipts" : "schema,candidate_source_sha,artifacts,fixture_observation");
  if ((row.schema !== "kizuki.acceptance-evidence/v1" && row.schema !== "kizuki.acceptance-evidence/v2" && !v3) || !Array.isArray(row.artifacts) || row.artifacts.length > TARGETS.length) reject("invalid-index");
  digest(row.candidate_source_sha, 40); const targets = new Set<string>();
  const allowV2 = row.schema === "kizuki.acceptance-evidence/v2" || v3;
  for (const raw of row.artifacts) {
    const ref = exact(raw, "producer,target,directory,proof,proof_sha256"), target = releaseTarget(text(ref.target));
    if ((ref.producer !== "kizuki.artifact-proof/v1" && !(allowV2 && ref.producer === "kizuki.artifact-proof/v2")) || targets.has(target.target)) reject("unknown-producer-or-duplicate-target");
    targets.add(target.target); absolute(ref.directory); absolute(ref.proof); digest(ref.proof_sha256);
  }
  if (row.fixture_observation !== null) {
    const fixture = exact(row.fixture_observation, "producer,directory,manifest_sha256,genesis_sha256,samples_sha256");
    if (fixture.producer !== "kizuki.qualification/v1") reject("unknown-producer");
    absolute(fixture.directory); for (const field of ["manifest_sha256", "genesis_sha256", "samples_sha256"]) digest(fixture[field]);
  }
  const gate_receipts = v3 ? parseGateReceipts(row.gate_receipts) : [];
  return { ...(row as unknown as EvidenceIndex), gate_receipts };
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
  const package_sha256 = Object.fromEntries(PACKAGE_FILES.map(name => [name, files[name]!.sha256])) as Record<ArtifactPackageFile, string>;
  const validated = validateArtifactProof(json(proof.bytes), { source_sha: candidate, target: ref.target, bun_version: build.bun_version, package_sha256 });
  if (validated.schema !== ref.producer) reject("proof-identity-mismatch");
  for (const file of Object.values(files)) file.unchanged(); proof.unchanged();
  return { target: ref.target, producer: ref.producer, producer_revision: null, scope: "automated-fixture-integrity", proof_sha256: proof.sha256,
    package_sha256, observation_interval: null, engine: validated.engine };
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

function gates(): Gate[] {
  const rows: Gate[] = [];
  const add = (id: string, scope: string, status: Status = "NOT_IMPLEMENTED", reason = "trusted-producer-not-implemented", required = true, target: string | null = null) => rows.push({ id, scope, status, reason, required, target, evidence_sha256: null });
  add("evidence.index", "evidence-integrity", "MISSING", "index-missing");
  for (const target of TARGETS) {
    add(`artifact.${target}`, "automated-fixture-integrity", "MISSING", "artifact-proof-missing", true, target);
    add(`engine.${target}`, "effective-sqlite-runtime", "MISSING", "missing-engine-proof", true, target);
    add(`native.${target}`, "native-execution-attestation", "UNVERIFIABLE", "producer-revision-and-native-attestation-unavailable", true, target);
    add(`lifecycle.${target}`, "native-installed-service", "NOT_IMPLEMENTED", "native-lifecycle-producer-not-implemented", true, target);
  }
  add("candidate.required-checks", "exact-candidate-ci"); add("candidate.independent-review", "independent-review");
  add("candidate.current-p0-disposition", "current-head-findings", "UNVERIFIABLE", "trusted-snapshot-and-freshness-policy-unavailable");
  add("surface.capabilities-and-docs", "product-surface-inventory");
  for (const journey of JOURNEYS) add(`journey.${journey}`, "complete-product-journey");
  for (const connector of CONNECTORS) add(`connector.${connector.id}`, connector.evidence);
  add("human.unfamiliar-user", "non-author-zero-coaching");
  add("owner.seven-day-rails", "supervised-owner-observation", "NOT_IMPLEMENTED", "superseded-readiness-gate", false);
  add("estate.fourteen-day-parity", "paired-estate-observation", "NOT_IMPLEMENTED", "superseded-readiness-gate", false);
  add("owner.final-cutover", "owner-operational-authority", "NOT_IMPLEMENTED", "superseded-readiness-gate", false);
  add("diagnostic.fixture-observation", "fixture-only", "MISSING", "fixture-observation-not-supplied", false);
  return rows;
}

export function evaluateRelease(profile: Profile, evidencePath: string) {
  if (profile !== "rc" && profile !== "1.0") reject("unsupported-profile");
  const rows = gates(), evidence: ReturnType<typeof verifyArtifact>[] = [];
  const row = (id: string) => rows.find(item => item.id === id)!;
  let index: EvidenceIndex | null = null, indexDigest: string | null = null, fixture: ReturnType<typeof fixtureDiagnostic> | null = null;
  const fail = (gate: Gate, error: unknown) => { gate.status = "FAIL"; gate.reason = (error instanceof EvidenceError || error instanceof ArtifactProofError) ? error.reason : "evidence-unreadable-or-invalid"; };
  try {
    const input = read(evidencePath, LIMITS.index_v3); indexDigest = input.sha256; index = parseIndex(json(input.bytes), input.bytes.length);
    const mapping = index.schema === "kizuki.acceptance-evidence/v3" ? gateReceiptMappingError(index.gate_receipts) : null;
    if (mapping) fail(row("evidence.index"), new EvidenceError(mapping));
    else Object.assign(row("evidence.index"), { status: "PASS", reason: "closed-index-validated", evidence_sha256: indexDigest });
  } catch (error) { fail(row("evidence.index"), error); }
  if (index) {
    for (const ref of index.artifacts) {
      const gate = row(`artifact.${ref.target}`), engine = row(`engine.${ref.target}`);
      try {
        const verified = verifyArtifact(ref, index.candidate_source_sha); evidence.push(verified);
        gate.evidence_sha256 = verified.proof_sha256; gate.status = "PASS"; gate.reason = "package-and-recorded-fixture-steps-consistent";
        Object.assign(engine, verified.engine, { evidence_sha256: verified.proof_sha256 });
      } catch (error) { fail(gate, error); fail(engine, error); }
    }
    if (index.fixture_observation) {
      const gate = row("diagnostic.fixture-observation");
      try { fixture = fixtureDiagnostic(index.fixture_observation, index); gate.evidence_sha256 = fixture.samples_sha256; gate.status = "PASS"; gate.reason = "fixture-observation-validated-no-release-credit"; }
      catch (error) { fail(gate, error); }
    }
  }
  // Revision hashes describe the actual local verifier files, including policy predicates.
  const capability = inspectOptionalVerifier(EVALUATOR_ROOT, CAPABILITY_PROOF_FILE);
  const verifier = [...VERIFIER_FILES.map(name => ({ file: name, sha256: hash(readFileSync(resolve(EVALUATOR_ROOT, name))) })), capability];
  if (index?.schema === "kizuki.acceptance-evidence/v3" && row("evidence.index").status === "PASS") {
    const surfaceActive = surfaceProducerActive(EVALUATOR_ROOT);
    for (const ref of index.gate_receipts) {
      if (ref.producer !== SURFACE_PRODUCER || ref.gate_id !== SURFACE_GATE) continue;
      if (!surfaceActive) continue;
      const gate = row(ref.gate_id);
      try {
        const file = read(ref.path, LIMITS.family_receipt);
        if (file.sha256 !== ref.sha256) reject("receipt-digest-mismatch");
        const evaluated = consumeSurfaceReceipt(json(file.bytes), EVALUATOR_ROOT, index.candidate_source_sha);
        file.unchanged();
        gate.status = evaluated.status; gate.reason = evaluated.reason; gate.evidence_sha256 = evaluated.creditDigest ? file.sha256 : null;
      } catch (error) { fail(gate, error); }
    }
  }
  const accepted = rows.filter(item => item.required).every(item => item.status === "PASS") && !rows.some(item => item.status === "FAIL");
  return { schema: "kizuki.acceptance-report/v2", profile, decision: accepted ? "GO" : "NO-GO", release_1_0_accepted: profile === "1.0" && accepted,
    candidate_source_sha: index?.candidate_source_sha ?? null, index_sha256: indexDigest, supported_bun_version: SUPPORTED_BUN_VERSION, policy_sha256: hash(JSON.stringify({ policy: POLICY, gates: { rc: gates(), "1.0": gates() } })), verifier_sha256: hash(JSON.stringify(verifier)), verifier,
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
  const bytes = JSON.stringify(report, null, 2) + "\n";
  const temporary = mkdtempSync(join(dirname(path), ".kizuki-acceptance-publish-"));
  const pending = join(temporary, "report.json");
  let cleanupFailed = false;
  try {
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    checkParents();
    // Hard-link publication is atomic and refuses an existing destination.
    // The final name cannot expose bytes before their write and fsync complete.
    linkSync(pending, path);
  } finally {
    // Preserve a write/publication error, and attempt both cleanup operations.
    try { rmSync(pending, { force: true }); } catch { cleanupFailed = true; }
    try { rmdirSync(temporary); } catch { cleanupFailed = true; }
  }
  try {
    // Once published, cleanup failure must not prevent the durability attempt.
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { reject("published-report-durability-unconfirmed"); }
  if (cleanupFailed) reject("published-report-cleanup-failed");
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
