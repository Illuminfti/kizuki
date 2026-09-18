import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumManifest, LEGACY_PACKAGE_FILES } from "./release-artifacts";
import { hash } from "./release-evidence";
import { prepareSession } from "./unfamiliar-user-session";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "human-worksheet-test-"));
  temporary.push(directory);
  for (const name of ["kizuki", "kizuki-mcp", "README.txt"]) writeFileSync(join(directory, name), "synthetic worksheet fixture; not an executable package\n");
  writeFileSync(join(directory, "BUILD.json"), JSON.stringify({ schema: "kizuki.release-build/v1", source_sha: "a".repeat(40), target: "bun-linux-x64-baseline", bun_version: "1.3.14" }));
  writeFileSync(join(directory, "SHA256SUMS"), checksumManifest(directory, LEGACY_PACKAGE_FILES.slice(0, -1)));
  return directory;
}

test("freeze a human task sheet without inventing results or acceptance", () => {
  const directory = fixture(), session = prepareSession(directory);
  expect(session.release_credit).toBe(false);
  expect(session.milestone_ms).toBe(900000);
  expect(session.tasks.map(task => task.id)).toEqual([
    "install", "source-consent", "canon-agent-query", "model-boundary",
    "correction-audit-undo", "source-health-revoke", "recovery", "accessibility",
  ]);
  expect(session.tasks.every(task => task.outcome === "UNRECORDED" && task.elapsed_ms === null && task.interventions === null)).toBe(true);
  expect(session.candidate_source_sha).toBe("a".repeat(40));
  expect(session.accessibility_modes).toEqual([
    { mode: "keyboard", supported: null, outcome: "UNRECORDED", inaccessible_steps: null },
    { mode: "reduced-motion", supported: null, outcome: "UNRECORDED", inaccessible_steps: null },
    { mode: "small-screen", supported: null, outcome: "UNRECORDED", inaccessible_steps: null },
  ]);
  expect(session.correction_observations).toEqual([
    { step: "correction", outcome: "UNRECORDED", elapsed_ms: null, receipt_reference: null },
    { step: "subsequent-query-context", outcome: "UNRECORDED", elapsed_ms: null, receipt_reference: null },
    { step: "audit", outcome: "UNRECORDED", elapsed_ms: null, receipt_reference: null },
    { step: "undo", outcome: "UNRECORDED", elapsed_ms: null, receipt_reference: null },
  ]);
  expect(session.tasks.find(task => task.id === "accessibility")?.instruction)
    .toContain("Report any inaccessible steps separately for each mode");
  expect(session.tasks.find(task => task.id === "correction-audit-undo")?.instruction)
    .toContain("query it again or inspect its updated context");
  expect(session.tasks.find(task => task.id === "install")?.instruction)
    .toContain("Install to a stable path, use normal init, and check that its supervisor service is active and enabled using the public instructions.");
  expect(session.tasks.find(task => task.id === "canon-agent-query")?.instruction)
    .toContain("Explain whether the result is useful to you and why, without sharing private source contents.");
  expect(session.tasks.find(task => task.id === "recovery")?.instruction)
    .toContain("verify both query and context against the restored content");
  expect(session.worksheet_generator_sha256).toBe(hash(readFileSync(join(import.meta.dir, "unfamiliar-user-session.ts"))));
  expect(session.participant_instructions_sha256).toBe(hash(JSON.stringify(
    session.tasks.map(({ id, instruction, required_outcome }) => [id, instruction, required_outcome]),
  )));
  expect(session.started_at).toBeNull();
  expect(session.timer_interruptions).toEqual([]);
  expect(session.tasks.every(task => task.interruption_notes === null)).toBe(true);
  expect(session.independent_eligibility_reference).toBeNull();
  for (const name of LEGACY_PACKAGE_FILES) expect(session.package_sha256[name]).toBe(hash(readFileSync(join(directory, name))));
  expect(session.protocol_sha256).toBe(hash(readFileSync(join(import.meta.dir, "../docs/unfamiliar-user-proof.md"))));
  expect(session.acceptance_checker_sha256).toBe(hash(readFileSync(join(import.meta.dir, "go-no-go.ts"))));
  // Keep the frozen milestone aligned with the existing release policy.
  expect(readFileSync(join(import.meta.dir, "go-no-go.ts"), "utf8")).toContain(`unfamiliar_user_ms: ${session.milestone_ms}`);
  expect(prepareSession(directory)).toEqual(session);
});

test("refuse changed package bytes before preparing a worksheet", () => {
  const directory = fixture();
  writeFileSync(join(directory, "kizuki"), "changed");
  expect(() => prepareSession(directory)).toThrow();
});

test("CLI emits a blank worksheet and reports errors without leaking paths", () => {
  const directory = fixture();
  const run = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "unfamiliar-user-session.ts"), ...args]);
  const ok = run(["--package", directory]);
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout.toString())).toEqual(prepareSession(directory));
  const bad = run(["--package", join(directory, "private-missing")]);
  expect(bad.exitCode).toBe(2);
  expect(bad.stdout.toString()).toBe("");
  expect(bad.stderr.toString()).not.toContain(directory);
  expect(run(["--package", directory, "--pass"]).exitCode).toBe(2);
});
