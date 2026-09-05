import { fixtureConsent } from "./helpers";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";
const helpers = createHelpers();
afterEach(helpers.cleanup);

test("offline public configured-engine rebuild preserves query results and survives refused rebuild", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  writeFileSync(join(setup.vault, ".kizuki", "serve.toml"), '[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\n');
  const deny = join(setup.root, "deny-fetch.ts");
  writeFileSync(deny, 'globalThis.fetch = async () => { throw new Error("runtime fetch forbidden"); };');
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "--preload", deny, resolve(import.meta.dir, "../src/main.ts"), ...args], {
      env: { ...process.env, ...setup.env }, timeout: 60_000,
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const before = run("query", "acme", "--json", "--degraded");
  expect(before.exitCode).toBe(0);
  expect(before.stdout).toContain("acme");
  const rebuilt = run("rebuild", "--layer", "all", "--json");
  expect(rebuilt.exitCode).toBe(0);
  const report = JSON.parse(rebuilt.stdout).data;
  expect(report.store).toBe("kizuki.retrieval.embedded-pg");
  expect(report.backend).toBe("retrieval-port");
  expect(report.floor_documents).toBeGreaterThan(0);
  const after = run("query", "acme", "--json");
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toContain("acme");
  const ids = (text: string) => JSON.parse(text).data.hits.map((hit: { doc_id: string }) => hit.doc_id).sort();
  expect(ids(after.stdout)).toEqual(ids(before.stdout));
  const bad = join(setup.vault, "facts", "broken.md");
  writeFileSync(bad, "---\nbroken: [\n---\nprivate malformed source");
  const refused = run("rebuild");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).not.toContain("private malformed source");
  rmSync(bad);
  const retained = run("query", "acme", "--json");
  expect(retained.exitCode).toBe(0);
  expect(ids(retained.stdout)).toEqual(ids(after.stdout));
  expect(run("rebuild", "--layer", "vector").exitCode).toBe(2);
}, 120_000);


test("default rebuild JSON and text identify the actual SQLite floor count", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const rebuilt = helpers.runCli(setup.env, "rebuild", "--json");
  expect(rebuilt.exitCode).toBe(0);
  const report = JSON.parse(rebuilt.stdout).data;
  const db = new Database(join(setup.vault, ".kizuki", "kizuki.db"), { readonly: true });
  try {
    const actual = db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_documents").get()!.n;
    expect(actual).toBeGreaterThan(0);
    expect(report).toMatchObject({ backend: "sqlite-floor", documents: actual, floor_documents: actual, store: "kizuki.retrieval.fts5" });
    const text = helpers.runCli(setup.env, "rebuild");
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`rebuilt=${actual} backend=sqlite-floor`);
    expect(text.stdout).toContain(`floor_documents=${actual}`);
  } finally { db.close(); }
});
