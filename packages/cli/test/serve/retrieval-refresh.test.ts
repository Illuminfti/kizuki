import { fixtureConsent } from "../helpers";
import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, retrievalDocId, serveSearch } from "@kizuki/core";
import { withReadVault } from "../../src/context";
import { openConfiguredRetrieval } from "../../src/retrieval-runtime";
import type { CliIo } from "../../src/commands";
import { openLedger } from "@kizuki/core/testing";
import { recordedPage } from "../../../core/test/helpers/recorded-page";
import { refreshDerived } from "../../src/derived";
import { createHelpers } from "../helpers";
const helpers = createHelpers();
afterEach(helpers.cleanup);

test("the offline retrieval rail refreshes edits and deletion for a reused engine while standalone reads declare the lexical floor", async () => {
  const f = helpers.tempVault();
  const evidence = "The library opens after sunrise. A later schedule moves opening to noon.";
  writeFileSync(join(f.notes, "library.md"), evidence);
  expect(helpers.runCli(f.env, "import", "markdown-folder", "--source", f.notes, ...fixtureConsent(f.root)).exitCode).toBe(0);
  const page = join(f.vault, "facts/orchard.md");
  const data = { id: "fact:orchard", title: "Orchard", type: "fact", status: "active", sensitivity: "personal", taint: "clean" };
  const writeRecordedPage = async (body: string) => {
    const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
    try {
      const sources = db.query<{ event_id: string }, [string]>("SELECT event_id FROM events WHERE text=?").all(evidence).map(row => row.event_id);
      expect(sources).toHaveLength(1);
      const recorded = await recordedPage(db, f.vault, "facts/orchard.md", data, body, sources);
      expect(recorded.receipt.authority).toBe("model_inference");
      expect(recorded.claim.provenance).toEqual(sources);
      expect(recorded.receipt.page_path).toBe("facts/orchard.md");
      // Complete the writer fixture's local index bookkeeping. The configured
      // retrieval engine remains empty until the public retrieval-sweep below.
      expect(refreshDerived(db, f.vault).degraded).toEqual([]);
    } finally { db.close(); }
  };
  await writeRecordedPage("The library opens after sunrise.");
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
  const rail = () => {
    const run = helpers.runCli(f.env, "serve", "run", "retrieval-sweep", "--json");
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout).data.status).toBe("ok");
  };
  const io: CliIo = { env: f.env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out() {}, err() {}, prompt: async () => "" };
  const query = async () => {
    // The host explicitly owns this writer-bound engine. The audited read reuses
    // that existing capability; it never calls the engine factory itself.
    const retrieval = await openConfiguredRetrieval(f.vault);
    expect(retrieval).toBeDefined();
    if (retrieval === undefined) throw new Error("synthetic configured engine is missing");
    try {
      return await withReadVault(io, async ctx => {
        const result = await serveSearch({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER, retrieval }, { query: "Orchrd", scope: "all", limit: 20 });
        return result.canon.map(hit => ({ doc_id: retrievalDocId("page", hit.page_id), authority: hit.authority, snippet: hit.excerpt }));
      }, { audit: true });
    } finally { await retrieval?.close(); }
  };
  expect(await query()).toEqual([]);
  rail();
  const first = await query();
  expect(first.map(hit => hit.doc_id)).toEqual(["page:fact:orchard"]);
  expect(first[0]?.authority).toBe("model_inference");
  expect(first[0]?.snippet).toContain("after sunrise");
  const standalone = helpers.runCli(f.env, "query", "Orchrd", "--json");
  expect(standalone.exitCode).toBe(0);
  expect(JSON.parse(standalone.stdout).data.hits).toEqual([]);
  expect(JSON.parse(standalone.stdout).degraded).toContain("configured-engine-unavailable");
  const lexical = helpers.runCli(f.env, "query", "Orchard", "--json");
  expect(lexical.exitCode).toBe(0);
  expect(JSON.parse(lexical.stdout).data.hits[0]?.doc_id).toBe("page:fact:orchard");

  expect(helpers.runCli(f.env, "rebuild", "--json").exitCode).toBe(0);
  expect(await query()).toEqual(first);
  await writeRecordedPage("The library opens at noon.");
  rail();
  expect((await query())[0]?.snippet).toContain("at noon");
  rmSync(page);
  rail();
  expect(await query()).toEqual([]);
}, 60_000);
