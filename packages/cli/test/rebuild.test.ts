import { fixtureConsent } from "./helpers";
import { loadConfiguredRetrieval, readRetrievalPortState } from "@kizuki/core";
import { openLedgerRead } from "@kizuki/core/internal";
import { fixtureSpaceId, writeFixtureGguf } from "@kizuki/embed-gguf";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";
import { openConfiguredEmbedding, openConfiguredRetrieval } from "../src/retrieval-runtime";
const helpers = createHelpers();
afterEach(helpers.cleanup);

function authoritativeState(vault: string) {
  const ctx = openLedgerRead(vault);
  try {
    return {
      events: ctx.db.query("SELECT event_id, source_record_id, content_hash FROM events ORDER BY event_id").all(),
      claims: ctx.db.query("SELECT claim_id FROM claims ORDER BY claim_id").all(),
      receipts: ctx.db.query("SELECT receipt_id FROM canon_receipts ORDER BY receipt_id").all(),
    };
  } finally {
    ctx.close();
  }
}

function eventDocIds(vault: string): Record<string, string> {
  const ctx = openLedgerRead(vault);
  try {
    return Object.fromEntries(
      ctx.db.query<{ source_record_id: string; event_id: string }, []>(
        "SELECT source_record_id, event_id FROM events",
      ).all().map((row) => [row.source_record_id, `event:${row.event_id}`]),
    );
  } finally {
    ctx.close();
  }
}

async function lexicalEventIds(
  port: { search: (query: {
    text: string;
    mode: "lexical";
    scope: { kinds: ["event"] };
    ceiling: "private";
    limit: number;
    deadline_ms: number;
  }) => Promise<{ hits: { doc_id: string }[] }> },
  text: string,
  limit: number,
): Promise<string[]> {
  const result = await port.search({
    text,
    mode: "lexical",
    scope: { kinds: ["event"] },
    ceiling: "private",
    limit,
    deadline_ms: 5_000,
  });
  return result.hits.map((hit) => hit.doc_id);
}

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
    const named = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.fts5", "--json");
    expect(named.exitCode, named.stdout + named.stderr).toBe(0);
    expect(JSON.parse(named.stdout).data.store).toBe("kizuki.retrieval.fts5");
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

test("search-only rebuild is immediately queryable and preserves graph and configuration", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "all", "--json").exitCode).toBe(0);
  const cursor = join(setup.vault, ".kizuki/index-cursor.json");
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  const snapshot = () => {
    const reader = openLedgerRead(setup.vault);
    try {
      return {
        documents: reader.db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
        docs: reader.db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
        search: reader.db.query("SELECT * FROM derived_meta WHERE layer='search'").all(),
        graph: reader.db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all(),
        graphMeta: reader.db.query("SELECT * FROM derived_meta WHERE layer='graph'").all(),
        cursor: existsSync(cursor) ? readFileSync(cursor) : null,
      };
    } finally { reader.close(); }
  };
  const before = snapshot();
  expect(before.documents.length).toBeGreaterThan(0);
  expect(existsSync(configPath)).toBe(false);
  const db = new Database(join(setup.vault, ".kizuki/kizuki.db"));
  try { db.exec("DELETE FROM search_documents"); }
  finally { db.close(); }
  const rebuilt = helpers.runCli(setup.env, "rebuild", "--layer", "search", "--json");
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  const report = JSON.parse(rebuilt.stdout).data;
  expect(report).toMatchObject({ backend: "sqlite-floor", store: "kizuki.retrieval.fts5" });
  const queried = helpers.runCli(setup.env, "query", "acme", "--json");
  expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
  expect(JSON.parse(queried.stdout).degraded).toEqual([]);
  expect(queried.stdout).toContain("acme");
  const retry = helpers.runCli(setup.env, "query", "acme", "--json");
  expect(JSON.parse(retry.stdout).data.hits.map((hit: { doc_id: string }) => hit.doc_id).sort())
    .toEqual(JSON.parse(queried.stdout).data.hits.map((hit: { doc_id: string }) => hit.doc_id).sort());
  const after = snapshot();
  expect(after.graph).toEqual(before.graph);
  expect(after.graphMeta).toEqual(before.graphMeta);
  expect(after.documents).toEqual(before.documents);
  expect(existsSync(configPath)).toBe(false);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "vector").exitCode).toBe(2);
  expect(helpers.runCli(setup.env, "rebuild", "--prune-old", "--layer", "search").exitCode).toBe(2);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "search", "--port", "kizuki.retrieval.embedded-pg").exitCode).toBe(1);
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
  expect(helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.no-such").exitCode).not.toBe(0);
  expect(helpers.runCli(setup.env, "rebuild", "--prune-old", "--layer", "all").exitCode).toBe(2);
  expect(helpers.runCli(setup.env, "rebuild", "--prune-old", "--port", "kizuki.retrieval.fts5").exitCode).toBe(2);
  expect(helpers.runCli(setup.env, "rebuild", "--prune-old", "--confirm").exitCode).toBe(2);
  mkdirSync(join(dataDir, "store"), { recursive: true });
  writeFileSync(join(dataDir, "store", "unknown"), "SYNTHETIC_KEEP");
  const refused = helpers.runCli(setup.env, "rebuild", "--prune-old", "--json");
  expect(refused.exitCode).not.toBe(0);
  expect(readFileSync(join(dataDir, "store", "unknown"), "utf8")).toBe("SYNTHETIC_KEEP");
}, 60_000);

function portState(vault: string) {
  const ctx = openLedgerRead(vault);
  try {
    return readRetrievalPortState(ctx.db);
  } finally {
    ctx.close();
  }
}

test("rebuild --port persists the default on a successful full rebuild", async () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  expect(existsSync(configPath)).toBe(false);

  const first = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--json");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  expect(JSON.parse(first.stdout).data).toMatchObject({
    backend: "retrieval-port",
    store: "kizuki.retrieval.embedded-pg",
  });
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.embedded-pg");
  expect(portState(setup.vault)?.port_id).toBe("kizuki.retrieval.embedded-pg");
  expect(existsSync(join(setup.vault, ".kizuki", "retrieval", "kizuki.retrieval.embedded-pg"))).toBe(true);
  const beforeState = authoritativeState(setup.vault);
  const docs = eventDocIds(setup.vault);
  expect(docs["ada.md"]).toBeDefined();
  expect(docs["grace.md"]).toBeDefined();
  expect(docs["linus.md"]).toBeDefined();
  const expectedGrace = [docs["ada.md"]!, docs["grace.md"]!].sort();
  const expectedLibrary = [docs["ada.md"]!];
  const expectedLinus = [docs["linus.md"]!];

  const { openConfiguredRetrieval } = await import("../src/retrieval-runtime");
  const searchGolden = async (port: NonNullable<Awaited<ReturnType<typeof openConfiguredRetrieval>>>) => {
    const grace = await lexicalEventIds(port, "grace", 2);
    const library = await lexicalEventIds(port, "library", 2);
    const linus = await lexicalEventIds(port, "linus", 2);
    expect([...grace].sort()).toEqual(expectedGrace);
    expect(library).toEqual(expectedLibrary);
    expect(linus).toEqual(expectedLinus);
    return { grace, library, linus };
  };

  const port = await openConfiguredRetrieval(setup.vault, "kizuki.retrieval.embedded-pg");
  expect(port).toBeDefined();
  let firstRecall: { grace: string[]; library: string[]; linus: string[] };
  try {
    firstRecall = await searchGolden(port!);
    const hits = await port!.search({
      text: "acme",
      mode: "lexical",
      scope: {},
      ceiling: "private",
      limit: 10,
      deadline_ms: 5_000,
    });
    expect(hits.hits.some((hit) => hit.snippet.toLowerCase().includes("acme"))).toBe(true);
  } finally {
    await port?.close();
  }

  const retry = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--json");
  expect(retry.exitCode, retry.stdout + retry.stderr).toBe(0);
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.embedded-pg");
  expect(authoritativeState(setup.vault)).toEqual(beforeState);

  const reopened = await openConfiguredRetrieval(setup.vault, "kizuki.retrieval.embedded-pg");
  expect(reopened).toBeDefined();
  try {
    const secondRecall = await searchGolden(reopened!);
    expect(secondRecall).toEqual(firstRecall);
  } finally {
    await reopened?.close();
  }

  const floor = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.fts5", "--json");
  expect(floor.exitCode, floor.stdout + floor.stderr).toBe(0);
  expect(JSON.parse(floor.stdout).data).toMatchObject({ backend: "sqlite-floor", store: "kizuki.retrieval.fts5" });
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.fts5");
  expect(portState(setup.vault)?.port_id).toBe("kizuki.retrieval.fts5");
  expect(existsSync(join(setup.vault, ".kizuki", "retrieval", "kizuki.retrieval.embedded-pg"))).toBe(true);
  expect(readFileSync(configPath, "utf8")).toContain('retrieval = "kizuki.retrieval.fts5"');

  const held = await openConfiguredRetrieval(setup.vault, "kizuki.retrieval.embedded-pg");
  expect(held).toBeDefined();
  try {
    const busy = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg");
    expect(busy.exitCode).not.toBe(0);
    expect((await held!.health()).status).toBe("ready");
  } finally {
    await held?.close();
  }
  expect(helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.no-such").exitCode).not.toBe(0);
  expect(helpers.runCli(setup.env, "rebuild", "--layer", "graph", "--port", "kizuki.retrieval.embedded-pg").exitCode).toBe(1);
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.fts5");
}, 120_000);

test("rebuild --layer search --port does not flip the default", async () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  const search = helpers.runCli(setup.env, "rebuild", "--layer", "search", "--port", "kizuki.retrieval.fts5", "--json");
  expect(search.exitCode, search.stdout + search.stderr).toBe(0);
  expect(existsSync(configPath)).toBe(false);
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.fts5");
  expect(portState(setup.vault)).toBeNull();
}, 60_000);

test("rebuild refuses an embedding-space change without --confirm", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const first = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--json");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  const enginePath = join(setup.vault, ".kizuki", "retrieval", "kizuki.retrieval.embedded-pg", "engine.json");
  const engine = JSON.parse(readFileSync(enginePath, "utf8")) as { space: string | null };
  writeFileSync(enginePath, `${JSON.stringify({ ...engine, space: "fixture:old@8" })}\n`);
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  writeFileSync(configPath, `[ports]
retrieval = "kizuki.retrieval.embedded-pg"

[ports.embedding]
id = "kizuki.embedding.gguf"
expected_space = "fixture:new@8"
`);
  const before = readFileSync(configPath, "utf8");
  const refused = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg");
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr).toContain("full re-embed from fixture:old@8 to fixture:new@8 requires --confirm");
  expect(refused.stderr).toContain("unmeasured");
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect((JSON.parse(readFileSync(enginePath, "utf8")) as { space: string }).space).toBe("fixture:old@8");
  expect(loadConfiguredRetrieval(setup.vault).id).toBe("kizuki.retrieval.embedded-pg");
}, 120_000);

test("rebuild --confirm binds the configured GGUF port and re-embeds", async () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const first = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--json");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  const enginePath = join(setup.vault, ".kizuki", "retrieval", "kizuki.retrieval.embedded-pg", "engine.json");
  const engine = JSON.parse(readFileSync(enginePath, "utf8")) as { space: string | null };
  writeFileSync(enginePath, `${JSON.stringify({ ...engine, space: "fixture:old@8" })}\n`);
  const modelPath = join(setup.root, "fixture.gguf");
  writeFileSync(modelPath, writeFixtureGguf());
  const space = fixtureSpaceId();
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  writeFileSync(configPath, `[ports]
retrieval = "kizuki.retrieval.embedded-pg"

[ports.embedding]
id = "kizuki.embedding.gguf"
model_path = ${JSON.stringify(modelPath)}
context_size = 32
batch_size = 4
expected_space = ${JSON.stringify(space)}
`);
  const rebuilt = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--confirm", "--json");
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  expect((JSON.parse(readFileSync(enginePath, "utf8")) as { space: string }).space).toBe(space);
  const embedding = await openConfiguredEmbedding(setup.vault);
  const port = await openConfiguredRetrieval(setup.vault, "kizuki.retrieval.embedded-pg", embedding === undefined ? {} : { embedding });
  try {
    expect(port).toBeDefined();
    const result = await port!.search({
      text: "grace",
      mode: "vector",
      scope: {},
      ceiling: "private",
      limit: 8,
      deadline_ms: 5_000,
    });
    expect(result.space).toBe(space);
    expect(result.degraded).not.toContain("embedding-space-mismatch");
    expect(result.hits.length).toBeGreaterThan(0);
  } finally {
    await port?.close();
    await embedding?.close();
  }
  writeFileSync(configPath, `[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\n`);
  const stripped = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg");
  expect(stripped.exitCode).not.toBe(0);
  expect(stripped.stderr).toContain("matching embedding port");
  expect((JSON.parse(readFileSync(enginePath, "utf8")) as { space: string }).space).toBe(space);
}, 120_000);

test("rebuild --confirm refuses an unavailable GGUF binding instead of dropping vector state", () => {
  const setup = helpers.tempVault();
  expect(helpers.runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode).toBe(0);
  const first = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--json");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  const enginePath = join(setup.vault, ".kizuki", "retrieval", "kizuki.retrieval.embedded-pg", "engine.json");
  const engine = JSON.parse(readFileSync(enginePath, "utf8")) as { space: string | null };
  writeFileSync(enginePath, `${JSON.stringify({ ...engine, space: "fixture:old@8" })}\n`);
  const configPath = join(setup.vault, ".kizuki", "serve.toml");
  writeFileSync(configPath, `[ports]
retrieval = "kizuki.retrieval.embedded-pg"

[ports.embedding]
id = "kizuki.embedding.gguf"
expected_space = "gguf:kizuki-fixture-embed@8"
`);
  const before = readFileSync(configPath, "utf8");
  const refused = helpers.runCli(setup.env, "rebuild", "--port", "kizuki.retrieval.embedded-pg", "--confirm");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("model_path");
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect((JSON.parse(readFileSync(enginePath, "utf8")) as { space: string }).space).toBe("fixture:old@8");
}, 120_000);
