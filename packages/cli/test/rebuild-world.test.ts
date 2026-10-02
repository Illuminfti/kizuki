import { fixtureConsent } from "./helpers";
import { openLedger } from "@kizuki/core/testing";
import { openLedgerRead } from "@kizuki/core/internal";
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);
const helpers = createHelpers();
afterEach(helpers.cleanup);

/** The cache tables the view work adds; every rebuild puts them back in their initial state. */
const VIEW_TABLES = ["world_view_partitions", "world_view_tokens", "world_view_token_deps", "world_resume_handles"];

const PRELOAD = resolve(import.meta.dir, "world-tables-preload.ts");
const MAIN = resolve(import.meta.dir, "../src/main.ts");

function runWithSyntheticTables(env: Record<string, string | undefined>, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "--preload", PRELOAD, MAIN, ...args], {
    env: { ...process.env, ...env } as Record<string, string>, timeout: 60_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function authoritativeState(vault: string) {
  const ctx = openLedgerRead(vault);
  try {
    return {
      events: ctx.db.query("SELECT event_id, content_hash FROM events ORDER BY event_id").all(),
      claims: ctx.db.query("SELECT claim_id FROM claims ORDER BY claim_id").all(),
    };
  } finally {
    ctx.close();
  }
}

test("rebuild --layer world resets derived and cache tables and leaves authority and search alone", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const ledgerPath = join(setup.vault, ".kizuki", "kizuki.db");
  const seed = openLedger(ledgerPath);
  seed.exec(`CREATE TABLE world_synth_summary(subject TEXT PRIMARY KEY, summary TEXT NOT NULL) STRICT;
    CREATE TABLE world_synth_slots(slot INTEGER PRIMARY KEY, token TEXT) STRICT;
    INSERT INTO world_synth_summary VALUES ('kettle','on'),('lamp','off');
    INSERT INTO world_synth_slots VALUES (7,'view-token');`);
  seed.close();
  const before = authoritativeState(setup.vault);
  const query = () => JSON.parse(helpers.runCli(setup.env, "query", "acme", "--json").stdout).data.hits.map((hit: { doc_id: string }) => hit.doc_id).sort();
  const hitsBefore = query();

  const rebuilt = runWithSyntheticTables(setup.env, "rebuild", "--layer", "world", "--json");
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  expect(JSON.parse(rebuilt.stdout).data).toEqual({
    layer: "world",
    tables: [...VIEW_TABLES, "world_synth_summary", "world_synth_slots"],
  });

  const after = openLedger(ledgerPath);
  try {
    expect(after.query("SELECT count(*) AS n FROM world_synth_summary").get()).toEqual({ n: 0 });
    expect(after.query("SELECT slot, token FROM world_synth_slots").all()).toEqual([{ slot: 0, token: null }]);
  } finally {
    after.close();
  }
  expect(authoritativeState(setup.vault)).toEqual(before);
  expect(query()).toEqual(hitsBefore);
});

test("rebuild --layer world with only the shipped cache tables succeeds and lists them", () => {
  const setup = helpers.tempVault();
  const text = helpers.runCli(setup.env, "rebuild", "--layer", "world");
  expect(text.exitCode, text.stderr).toBe(0);
  expect(text.stdout.trim()).toBe(`world_tables_reset=${VIEW_TABLES.length}`);
  const json = helpers.runCli(setup.env, "rebuild", "--layer", "world", "--json");
  expect(JSON.parse(json.stdout).data).toEqual({ layer: "world", tables: VIEW_TABLES });
});

test("rebuild --layer world refuses a retrieval port and a budget option", () => {
  const setup = helpers.tempVault();
  const port = helpers.runCli(setup.env, "rebuild", "--layer", "world", "--port", "kizuki.retrieval.fts5");
  expect(port.exitCode).toBe(1);
  expect(port.stderr).toContain("partial layer rebuild is not supported for a configured retrieval engine");
  const budget = helpers.runCli(setup.env, "rebuild", "--layer", "world", "--max-records", "5");
  expect(budget.exitCode).toBe(2);
  expect(budget.stderr).toContain("rebuild --layer world takes no budget option");
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "vector").exitCode).toBe(2);
});
