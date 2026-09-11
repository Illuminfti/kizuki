import { fixtureConsent } from "./helpers";
import { openLedgerRead } from "@kizuki/core/internal";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
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
  expect(run("rebuild", "--port", "kizuki.retrieval.fts5").exitCode).toBe(2);
}, 120_000);


test("default rebuild JSON and text identify the actual SQLite floor count", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const rebuilt = helpers.runCli(setup.env, "rebuild", "--json");
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  const report = JSON.parse(rebuilt.stdout).data;
  const reader = openLedgerRead(setup.vault);
  try {
    const actual = reader.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_documents").get()!.n;
    reader.assertCurrent();
    expect(actual).toBeGreaterThan(0);
    expect(report).toMatchObject({ backend: "sqlite-floor", documents: actual, floor_documents: actual, store: "kizuki.retrieval.fts5" });
    const text = helpers.runCli(setup.env, "rebuild");
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`rebuilt=${actual} backend=sqlite-floor`);
    expect(text.stdout).toContain(`floor_documents=${actual}`);
  } finally { reader.close(); }
});

for (const historical of ["ledger15", "ledger16"]) test(`public rebuild makes migrated ${historical} immediately queryable and preserves its cursor on refusal`, async () => {
  const setup = helpers.tempVault();
  const {openCanonFiles} = await import("../../core/src/vault/canon-files");
  const {replayHistoricalRecoverySql} = await import("../../../scripts/native-recovery-fixtures");
  const {readFileSync,existsSync} = await import("node:fs");
  const files=openCanonFiles(setup.vault);
  try {const prior=files.readPrivate(".kizuki/kizuki.db");expect(prior).not.toBeNull();const stage=files.create(".kizuki/fixture-ledger.tmp",new Uint8Array());files.replace(stage,prior!);}finally{files.close();}
  replayHistoricalRecoverySql(setup.vault,historical);
  expect(helpers.runCli(setup.env,"init",setup.vault,"--no-service","--no-default").exitCode).toBe(0);
  const stale=helpers.runCli(setup.env,"query","synthetic","--scope","ledger","--json");expect(stale.exitCode).toBe(1);expect(stale.stderr).toContain("index-behind-ledger");
  const rebuilt=helpers.runCli(setup.env,"rebuild","--json");expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  const queried=helpers.runCli(setup.env,"query","synthetic","--scope","ledger","--json");expect(queried.exitCode).toBe(0);expect(queried.stderr).toBe("");
  const envelope=JSON.parse(queried.stdout);expect(envelope.status).toBe("ok");expect(envelope.degraded).toEqual([]);expect(envelope.warnings).toEqual([]);expect(envelope.data.hits).toHaveLength(1);expect(envelope.data.hits[0].snippet).toContain("synthetic");
  const cursor=join(setup.vault,".kizuki/index-cursor.json");expect(existsSync(cursor)).toBe(true);const before=readFileSync(cursor);
  const malformed=join(setup.vault,"facts/rebuild-refused.md");writeFileSync(malformed,"---\nbroken: [\n---\nSynthetic malformed fixture");
  const refused=helpers.runCli(setup.env,"rebuild","--json");expect(refused.exitCode).toBe(1);expect(readFileSync(cursor)).toEqual(before);rmSync(malformed);
  expect(helpers.runCli(setup.env,"query","synthetic","--scope","ledger","--json").exitCode).toBe(0);
});

test("graph-only rebuild restores graph without refreshing search", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "all", "--json").exitCode).toBe(0);
  const cursor = join(setup.vault, ".kizuki/index-cursor.json");
  const snapshot = () => {
    const reader = openLedgerRead(setup.vault);
    try {
      return {
        documents: reader.db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
        docs: reader.db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
        search: reader.db.query("SELECT * FROM derived_meta WHERE layer='search'").all(),
        graph: reader.db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all(),
        cursor: existsSync(cursor) ? readFileSync(cursor) : null,
      };
    } finally { reader.close(); }
  };
  const before = snapshot();
  expect(before.documents.length).toBeGreaterThan(0);
  const db = new Database(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    db.exec("DELETE FROM graph_edges");
    db.exec("INSERT INTO graph_edges (src,dst,kind,sensitivity,taint,authority,provenance) VALUES ('junk','junk','wikilink','public','clean','model_inference','[]')");
  } finally { db.close(); }
  const rebuilt = helpers.runCli(setup.env, "rebuild", "--layer", "graph", "--json");
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  const report = JSON.parse(rebuilt.stdout).data;
  expect(report).toMatchObject({ backend: "sqlite-floor", store: "kizuki.retrieval.fts5" });
  const after = snapshot();
  expect(after.documents).toEqual(before.documents);
  expect(after.docs).toEqual(before.docs);
  expect(after.search).toEqual(before.search);
  expect(after.cursor).toEqual(before.cursor);
  expect(after.graph).toEqual(before.graph);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "vector").exitCode).toBe(2);
}, 60_000);

test("prune-old removes an inactive FTS generation and keeps the lexical floor", async () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  expect(helpers.runCli(setup.env, "rebuild", "--json").exitCode).toBe(0);
  const { createFts5RetrievalPort, FTS5_RETRIEVAL_ID } = await import("@kizuki/core");
  const { SYNTHETIC_DOCS } = await import("../../core/test/contracts/fixtures");
  const dataDir = join(setup.vault, ".kizuki/retrieval", FTS5_RETRIEVAL_ID);
  const port = createFts5RetrievalPort({
    vault_path: setup.vault, data_dir: dataDir, config: {},
    clock: () => new Date().toISOString(), secrets: async () => "", logger: () => {},
  });
  await port.upsert(SYNTHETIC_DOCS);
  await port.close();
  expect(existsSync(join(dataDir, "store"))).toBe(true);
  const reader = openLedgerRead(setup.vault);
  let floor: unknown[] = [];
  try { floor = reader.db.query("SELECT * FROM search_documents ORDER BY doc_id").all(); }
  finally { reader.close(); }
  const pruned = helpers.runCli(setup.env, "rebuild", "--prune-old", "--json");
  expect(pruned.exitCode, pruned.stdout + pruned.stderr).toBe(0);
  const report = JSON.parse(pruned.stdout).data;
  expect(report).toMatchObject({ mode: "prune-old", kept: null });
  expect(report.pruned).toContain(FTS5_RETRIEVAL_ID);
  expect(existsSync(join(dataDir, "store"))).toBe(false);
  const after = openLedgerRead(setup.vault);
  try { expect(after.db.query("SELECT * FROM search_documents ORDER BY doc_id").all()).toEqual(floor); }
  finally { after.close(); }
  const again = helpers.runCli(setup.env, "rebuild", "--prune-old");
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toContain("pruned=none");
  expect(helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.fts5").exitCode).toBe(2);
  expect(helpers.runCli(setup.env, "rebuild", "--prune-old", "--layer", "all").exitCode).toBe(2);
  mkdirSync(join(dataDir, "store"), { recursive: true });
  writeFileSync(join(dataDir, "store", "unknown"), "SYNTHETIC_KEEP");
  const refused = helpers.runCli(setup.env, "rebuild", "--prune-old", "--json");
  expect(refused.exitCode).not.toBe(0);
  expect(readFileSync(join(dataDir, "store", "unknown"), "utf8")).toBe("SYNTHETIC_KEEP");
}, 60_000);
