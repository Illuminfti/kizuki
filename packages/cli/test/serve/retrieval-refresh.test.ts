import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializePage } from "@kizuki/core";
import { createHelpers } from "../helpers";
const helpers = createHelpers();
afterEach(helpers.cleanup);

test("the offline retrieval rail refreshes canon edits and deletion through the public consumer", () => {
  const f = helpers.tempVault();
  expect(helpers.runCli(f.env, "import", "markdown-folder", "--source", f.notes).exitCode).toBe(0);
  const page = join(f.vault, "facts/orchard.md");
  const data = { id: "fact:orchard", title: "Orchard", type: "fact", status: "active", sensitivity: "personal", taint: "clean" };
  writeFileSync(page, serializePage({ data, body: "The library opens after sunrise." }));
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
  expect(first[0]?.authority).toBe("owner_authored");
  expect(first[0]?.snippet).toContain("after sunrise");
  expect(helpers.runCli(f.env, "rebuild", "--json").exitCode).toBe(0);
  expect(query()).toEqual(first);
  writeFileSync(page, serializePage({ data, body: "The library opens at noon." }));
  rail();
  expect(query()[0]?.snippet).toContain("at noon");
  rmSync(page);
  rail();
  expect(query()).toEqual([]);
}, 60_000);
