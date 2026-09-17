/** Prepare a blank, package-bound human worksheet. Never awards release credit. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checksumManifest, packageFiles, parseBuildInfo, verifyPackageDirectory } from "./release-artifacts";
import { releaseTarget } from "./release-targets";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const TASKS = [
  ["install", "Install the supplied package and create a private workspace using only public instructions.", "Normal init installs an active, enabled supervisor service; no hidden setup."],
  ["source-consent", "Connect the agreed supported source after reviewing its consent.", "Explicit account, fields, history and destinations; ingestion from that scope only."],
  ["canon-agent-query", "Find useful knowledge from your source through an authorized agent and inspect its provenance.", "Autonomous model-written canon and an authorized agent query within 900000 ms of receiving the package; source-linked usefulness recorded."],
  ["model-boundary", "Explain what remains available without a model and what requires one.", "Capture, ledger, search, timeline, context, audit and undo remain available; canon writing requires a configured model."],
  ["correction-audit-undo", "Correct a belief, query it again or inspect its updated context, inspect the change and its receipt, then undo it.", "Observe correction, subsequent query/context, audit and undo separately; no approval queue."],
  ["source-health-revoke", "Inspect source health, then revoke the selected source.", "Participant understands health and revocation outcome; record errors without account contents."],
  ["recovery", "Use the documented backup and clean-target restore route, then query restored content.", "Record completion, failures and losses; technical restore/purge qualification remains separate."],
  ["accessibility", "Try the supported keyboard, reduced-motion and small-screen routes.", "Record each mode's outcome and inaccessible steps; automation is not a human outcome."],
] as const;

export function prepareSession(directory: string) {
  const build = parseBuildInfo(join(directory, "BUILD.json"));
  releaseTarget(build.target);
  verifyPackageDirectory(directory, build);
  const names = packageFiles(build);
  const before = checksumManifest(directory, names);
  const package_sha256 = Object.fromEntries(before.trimEnd().split("\n").map(line => [line.slice(66), line.slice(0, 64)]));
  verifyPackageDirectory(directory, build);
  if (checksumManifest(directory, names) !== before) throw new Error("package changed");
  const protocol = readFileSync(join(import.meta.dir, "../docs/unfamiliar-user-proof.md"));
  const policy = readFileSync(join(import.meta.dir, "go-no-go.ts"));
  return {
    schema: "kizuki.unfamiliar-user-worksheet/v1",
    release_credit: false,
    candidate_source_sha: build.source_sha,
    target: build.target,
    bun_version: build.bun_version,
    package_sha256,
    worksheet_generator_sha256: hash(readFileSync(import.meta.path)),
    protocol_sha256: hash(protocol),
    acceptance_checker_sha256: hash(policy),
    participant_instructions_sha256: hash(JSON.stringify(TASKS)),
    milestone_ms: 900000,
    attempt_id: null,
    prior_attempt_references: [],
    public_install_route: null,
    environment: null,
    participant_consent_reference: null,
    independent_eligibility_reference: null,
    candidate_qualification_reference: null,
    source_and_model_authorization_reference: null,
    started_at: null,
    monotonic_start_ms: null,
    timer_interruptions: [],
    first_useful_result_ms: null,
    canon_agent_milestone_ms: null,
    usefulness: null,
    correction_observations: ["correction", "subsequent-query-context", "audit", "undo"].map(step => ({
      step, outcome: "UNRECORDED", elapsed_ms: null, receipt_reference: null,
    })),
    limitations: [],
    accessibility_modes: ["keyboard", "reduced-motion", "small-screen"].map(mode => ({
      mode, supported: null, outcome: "UNRECORDED", inaccessible_steps: null,
    })),
    tasks: TASKS.map(([id, instruction, required_outcome]) => ({
      id, instruction, required_outcome, outcome: "UNRECORDED", elapsed_ms: null,
      interventions: null, confusion: null, inaccessible_steps: null, error_recovery: null,
      interruption_notes: null,
    })),
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--package" || !args[1]) throw new Error("invalid arguments");
    process.stdout.write(JSON.stringify(prepareSession(args[1]), null, 2) + "\n");
  } catch {
    process.stderr.write("worksheet-failed: use --package VERIFIED_PACKAGE_DIRECTORY; no acceptance credit or participant evidence is generated\n");
    process.exitCode = 2;
  }
}
