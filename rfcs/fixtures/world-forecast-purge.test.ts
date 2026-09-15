/** Design-only check that purge reaches derived analysis and caches. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-purge-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  derived: { kind: string; cache_refs: string[] };
  invalidation: {
    kind: string;
    derived_invalid: boolean;
    cache_invalid: boolean;
    fork_bypasses_consent: boolean;
  };
  oracle: {
    derived_survives: boolean;
    cache_survives: boolean;
    consent_bypassed: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function purgeErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "purge-propagates-through-derived-analysis") errors.push("unexpected example id");
  if (example.derived.kind !== "derived_analysis") errors.push("derived kind drifted");
  if (example.derived.cache_refs.length === 0) errors.push("cache refs dropped");
  if (example.invalidation.kind !== "revocation") errors.push("invalidation kind drifted");
  if (!example.invalidation.derived_invalid) errors.push("derived analysis survived");
  if (!example.invalidation.cache_invalid) errors.push("derived cache survived");
  if (example.invalidation.fork_bypasses_consent) errors.push("a forked world bypassed consent");
  if (example.oracle.derived_survives) errors.push("oracle kept derived analysis");
  if (example.oracle.cache_survives) errors.push("oracle kept the cache");
  if (example.oracle.consent_bypassed) errors.push("oracle allowed a consent bypass");
  return errors;
}

test("purge and revocation propagate through derived analysis and caches", () => {
  expect(purgeErrors(load())).toEqual([]);
});

test("surviving derived analysis or bypassing consent fails", () => {
  const example = load();
  expect(purgeErrors(example)).toEqual([]);
  expect(
    purgeErrors({
      ...example,
      invalidation: {
        ...example.invalidation,
        derived_invalid: false,
        cache_invalid: false,
        fork_bypasses_consent: true,
      },
      oracle: { derived_survives: true, cache_survives: true, consent_bypassed: true },
    }).length,
  ).toBeGreaterThan(0);
});
