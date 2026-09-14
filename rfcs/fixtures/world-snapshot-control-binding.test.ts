/** Design-only check that restore snapshots keep declared policy and correction controls. */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "rfcs/fixtures");
const VALIDATOR = join(FIXTURES, "validate-world-design.ts");
const CONCEPT = "world-concept-design.json";
const LONGITUDINAL = "world-longitudinal-design.json";
const REQUIRED = [
  "base:ctl_revoke_s1",
  "base:ctl_purge_s1",
  "base:ctl_purge_copy",
  "base:ctl_narrow_g1",
  "x_ctl_correct_c1",
] as const;

type Fixture = {
  evaluation_state: string;
  input: { snapshot: { retained_control_refs: string[] } };
};

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function mutateLongitudinal(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-snapshot-control-"));
  try {
    copyFileSync(join(FIXTURES, CONCEPT), join(dir, CONCEPT));
    const fixture = JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Fixture;
    mutate(fixture);
    writeFileSync(join(dir, LONGITUDINAL), `${JSON.stringify(fixture)}\n`);
    return validate(dir).exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unchanged fixtures retain the declared restore-control inventory", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("omitting, duplicating, or substituting a retained restore control fails", () => {
  for (const id of REQUIRED) {
    expect(
      mutateLongitudinal((fixture) => {
        fixture.input.snapshot.retained_control_refs = REQUIRED.filter((item) => item !== id);
      }),
    ).not.toBe(0);
  }
  expect(
    mutateLongitudinal((fixture) => {
      fixture.input.snapshot.retained_control_refs = [...REQUIRED, "x_ctl_correct_c1"];
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      fixture.input.snapshot.retained_control_refs = [
        "base:ctl_revoke_s1",
        "base:ctl_purge_s1",
        "base:ctl_purge_copy",
        "base:ctl_narrow_g1",
        "x_ctl_export",
      ];
    }),
  ).not.toBe(0);
});
