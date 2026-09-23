import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { emptyIndexCursor, writeIndexCursor } from "../../src/derived";
import { createHelpers, fixtureConsent } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const helpers = createHelpers();
afterEach(helpers.cleanup);

// Adapted from PR #987 (agent/oracle-backlog-983). It isolates the sweep: only
// the retrieval-sweep rail runs, so the catch-up cannot be credited to import
// or to the sync rail's own refresh.
test("the retrieval sweep alone catches a reset index up and query stops refusing", async () => {
  const setup = helpers.tempVault();
  const imported = helpers.runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode, imported.stderr).toBe(0);
  expect(helpers.runCli(setup.env, "query", "acme").exitCode).toBe(0);

  writeIndexCursor(setup.vault, emptyIndexCursor());
  const stale = helpers.runCli(setup.env, "query", "acme");
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("search index is stale");

  const sweep = await helpers.runCliAsync(setup.env, "serve", "run", "retrieval-sweep", "--json");
  expect(sweep.exitCode, sweep.stdout + sweep.stderr).toBe(0);
  const receipt = JSON.parse(sweep.stdout) as {
    data: { status: string; retrieval: { upserts: number; pending_ops: number } };
  };
  expect(receipt.data.status).toBe("ok");
  expect(receipt.data.retrieval.upserts).toBeGreaterThan(0);
  expect(receipt.data.retrieval.pending_ops).toBe(0);

  const queried = helpers.runCli(setup.env, "query", "acme");
  expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
  expect(queried.stdout).toContain("acme");
}, 120_000);
