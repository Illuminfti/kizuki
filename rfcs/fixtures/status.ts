/**
 * The one place a world design fixture is promoted from a design to an
 * executable check. A design fixture never calls product code, so its own
 * declared status stays a design statement; this registry says whether a real
 * test binds it. Promoting an id is one line here: replace `deferred(owner)`
 * with `executable(test)`, naming the test file that runs the fixture against
 * the product.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/** Workstream keys of the world-model program that may own a deferred id. */
export const WORKSTREAM_KEYS = [
  "F1A", "F1B", "F2", "F3", "F4", "F5", "DOC0", "ENV", "VIEW", "CARD", "KNOWN",
  "CORRECT", "IDENT", "CONSOL", "VERIFY", "GOLDEN", "QUEST", "PEOPLE", "SKILL",
  "SIT2", "ART", "OUTCOME", "DIFF", "SLICE", "ATTN", "FCST", "ATLAS", "REFS",
  "PARITY", "BACKUP", "DOCS",
] as const;
export type WorkstreamKey = (typeof WORKSTREAM_KEYS)[number];

export type FixtureStatus =
  | { readonly status: "deferred"; readonly owner: WorkstreamKey }
  | { readonly status: "executable"; readonly test: string };
export type FixtureRegistry = Readonly<Record<string, FixtureStatus>>;

/** What every design file declares about itself while its owner has not bound it. */
const DESIGN_ONLY = "future_unimplemented";

export const deferred = (owner: WorkstreamKey): FixtureStatus => ({ status: "deferred", owner });
/** `test` is repository relative and must exist. */
export const executable = (test: string): FixtureStatus => ({ status: "executable", test });

/** One entry per file in this directory, keyed by file name without `.json`. */
export const FIXTURE_STATUS: FixtureRegistry = {
  "world-artifact-content-binding": deferred("ART"),
  "world-artifact-text-region": deferred("ART"),
  "world-atlas-projection-design": deferred("ATLAS"),
  "world-concept-absence-design": deferred("CARD"),
  "world-concept-design": deferred("VERIFY"),
  "world-consolidation-copy-design": deferred("CONSOL"),
  "world-consolidation-corpus-design": deferred("CONSOL"),
  "world-consolidation-empty-design": deferred("CONSOL"),
  "world-consolidation-freshness-design": deferred("CONSOL"),
  "world-consolidation-inflight-design": deferred("CONSOL"),
  "world-consolidation-recovery-design": deferred("CONSOL"),
  "world-consolidation-source-loss-design": deferred("CONSOL"),
  "world-consolidation-unavailable-design": deferred("CONSOL"),
  "world-cue-coverage-design": deferred("ATTN"),
  "world-cue-dismissal-design": deferred("ATTN"),
  "world-cue-quiet-design": deferred("ATTN"),
  "world-forecast-baseline-design": deferred("FCST"),
  "world-forecast-counterfactual-design": deferred("FCST"),
  "world-forecast-hypothesis-design": deferred("FCST"),
  "world-forecast-prefix-design": deferred("FCST"),
  "world-forecast-purge-design": deferred("FCST"),
  "world-forecast-scoring-design": deferred("FCST"),
  "world-longitudinal-design": deferred("VERIFY"),
  "world-outcome-confounded-design": deferred("OUTCOME"),
  "world-outcome-copy-design": deferred("OUTCOME"),
  "world-outcome-evidence-design": deferred("OUTCOME"),
  "world-outcome-mastery-design": deferred("OUTCOME"),
  "world-outcome-matched-evaluation-design": deferred("OUTCOME"),
  "world-outcome-purge-design": deferred("OUTCOME"),
  "world-outcome-replay-design": deferred("OUTCOME"),
  "world-outcome-stages-design": deferred("OUTCOME"),
  "world-outcome-usefulness-design": deferred("OUTCOME"),
  "world-perspective-binding-design": deferred("PEOPLE"),
  "world-procedure-evidence-design": deferred("SKILL"),
  "world-question-copy-design": deferred("QUEST"),
  "world-question-reopen-design": deferred("QUEST"),
  "world-slice-budget-design": deferred("SLICE"),
  "world-slice-partial-design": deferred("SLICE"),
};

/**
 * One entry per oracle assertion of the two fixtures that carry many, keyed
 * `<fixture id>#<assertion id>`. Every other fixture is one oracle unit.
 */
export const ORACLE_ASSERTION_STATUS: FixtureRegistry = {
  "world-concept-design#a_before_interpretation": deferred("KNOWN"),
  "world-concept-design#a_initial_raw": deferred("CARD"),
  "world-concept-design#a_initial_concept": deferred("IDENT"),
  "world-concept-design#a_copy": deferred("CARD"),
  "world-concept-design#a_hidden_mutation": deferred("VIEW"),
  "world-concept-design#a_owner_identity": deferred("IDENT"),
  "world-concept-design#a_historical_before_correction": deferred("KNOWN"),
  "world-concept-design#a_correction": deferred("CORRECT"),
  "world-concept-design#a_stale_job": deferred("CONSOL"),
  "world-concept-design#a_revoke": deferred("CONSOL"),
  "world-concept-design#a_first_purge_scope": deferred("CONSOL"),
  "world-concept-design#a_copy_raw_retained": deferred("CARD"),
  "world-concept-design#a_second_purge": deferred("CONSOL"),
  "world-concept-design#a_erased_history": deferred("KNOWN"),
  "world-concept-design#a_owner_baseline": deferred("VIEW"),
  "world-concept-design#a_narrowed_old_view": deferred("VIEW"),
  "world-concept-design#a_narrowed_fresh": deferred("VIEW"),
  "world-longitudinal-design#x_a_conflict": deferred("SIT2"),
  "world-longitudinal-design#x_a_correction": deferred("CORRECT"),
  "world-longitudinal-design#x_a_agent": deferred("OUTCOME"),
  "world-longitudinal-design#x_a_ack": deferred("OUTCOME"),
  "world-longitudinal-design#x_a_wrong": deferred("OUTCOME"),
  "world-longitudinal-design#x_a_correct": deferred("OUTCOME"),
  "world-longitudinal-design#x_a_restore_old": deferred("VIEW"),
  "world-longitudinal-design#x_a_restore_fresh": deferred("VIEW"),
};

/** Absolute path of the repository root, resolved from this file. */
export const REPOSITORY_ROOT = join(import.meta.dir, "../..");

/** Where a product test may live: under rfcs/ or a package's test directory. */
const TEST_PATH = /^(?:rfcs\/|packages\/[^/]+\/test\/).+\.test\.ts$/;

/** The registry's own files prove nothing about a fixture, so none of them may be a binding. */
const REGISTRY_FILES: readonly string[] = [
  "rfcs/fixtures/status.ts",
  "rfcs/fixtures/fixture-status.test.ts",
  "rfcs/fixtures/oracle-coverage.ts",
  "rfcs/fixtures/oracle-coverage.test.ts",
];

/**
 * Why a registered test path cannot be trusted, or an empty list when it is a
 * real test file that names the unit it binds. `unit` is a fixture id or a
 * `<fixture id>#<assertion id>` key; the file text must contain either the unit
 * or its fixture id, so a promotion line cannot point at an unrelated file.
 */
export function boundTestErrors(test: string, root: string, unit: string): string[] {
  const clean = normalize(test);
  if (isAbsolute(test) || clean.startsWith("..") || clean !== test) {
    return [`${test} is not a normalized repository-relative path`];
  }
  if (!TEST_PATH.test(test)) return [`${test} is not a test file under rfcs/ or packages/*/test/`];
  if (REGISTRY_FILES.includes(test)) return [`${test} is part of the registry and cannot bind a fixture`];
  const path = join(root, clean);
  if (!existsSync(path) || !lstatSync(path).isFile()) return [`${test} does not exist`];
  const fixture = unit.split("#", 1)[0]!;
  const text = readFileSync(path, "utf8");
  if (!text.includes(unit) && !text.includes(fixture)) return [`${test} never names ${fixture}`];
  return [];
}

/**
 * Errors for a design fixture that declares `declared` as its own status. A
 * deferred fixture must still declare itself unimplemented; an executable one
 * needs its registered test file. Empty means the declaration is honest.
 */
export function fixtureStatusErrors(
  id: string,
  declared: unknown,
  registry: FixtureRegistry = FIXTURE_STATUS,
  root: string = REPOSITORY_ROOT,
): string[] {
  const entry = Object.hasOwn(registry, id) ? registry[id] : undefined;
  if (entry === undefined) return [`${id} is not in the fixture status registry`];
  if (declared !== DESIGN_ONLY) return [`${id} must declare ${DESIGN_ONLY}, found ${String(declared)}`];
  return entry.status === "executable" ? boundTestErrors(entry.test, root, id) : [];
}
