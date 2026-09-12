import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor --json reports live claim counts above the sample list cap", () => {
  const setup = tempVault();
  for (let index = 0; index < 6; index += 1) {
    writeFileSync(join(setup.notes, `extra-${index}.md`), `synthetic note ${index} about acme\n`);
  }
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);

  const doctor = runCli(setup.env, "doctor", "--json");
  expect(doctor.exitCode).toBe(0);
  const body = JSON.parse(doctor.stdout) as {
    data: {
      events: number;
      claims: { live: number };
      live_claims: unknown[];
    };
  };
  expect(body.data.events).toBeGreaterThan(8);
  expect(body.data.claims.live).toBeGreaterThan(8);
  expect(body.data.live_claims).toHaveLength(8);
  expect(body.data.claims.live).toBeGreaterThan(body.data.live_claims.length);
});
