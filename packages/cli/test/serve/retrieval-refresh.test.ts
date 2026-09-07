import { fixtureConsent } from "../helpers";
import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { recordedPage } from "../../../core/test/helpers/recorded-page";
import { refreshDerived } from "../../src/derived";
import { createHelpers } from "../helpers";
const helpers = createHelpers();
afterEach(helpers.cleanup);

test("the offline retrieval rail refreshes canon edits and deletion through the public consumer", async () => {
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
  const query = () => {
    const run = helpers.runCli(f.env, "query", "Orchrd", "--json");
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout).data.hits as { doc_id: string; authority: string; snippet: string }[];
  };
  expect(query()).toEqual([]);
  rail();
  const first = query();
  expect(first.map(hit => hit.doc_id)).toEqual(["page:fact:orchard"]);
  expect(first[0]?.authority).toBe("model_inference");
  expect(first[0]?.snippet).toContain("after sunrise");
  expect(helpers.runCli(f.env, "rebuild", "--json").exitCode).toBe(0);
  expect(query()).toEqual(first);
  await writeRecordedPage("The library opens at noon.");
  rail();
  expect(query()[0]?.snippet).toContain("at noon");
  rmSync(page);
  rail();
  expect(query()).toEqual([]);
}, 60_000);
