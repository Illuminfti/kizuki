import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializePage } from "../../../core/src/vault/frontmatter";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor reports full live capacity and archived counts in text and JSON", () => {
  const setup = tempVault();
  writeFileSync(join(setup.vault, ".kizuki", "serve.toml"), "[canon]\nmax_live_pages = 100\n", { mode: 0o600 });
  const directory = join(setup.vault, "bulk");
  mkdirSync(directory);
  for (let index = 0; index < 105; index++) {
    const id = `fact:capacity-${index}`;
    writeFileSync(join(directory, `${index}.md`), serializePage({
      data: { id, title: id, type: "fact", status: index < 100 ? "active" : "archived", sensitivity: "personal", taint: "clean", sources: [] },
      body: "A synthetic note.\n",
    }));
  }
  const json = runCli(setup.env, "doctor", "--json");
  expect(json.exitCode).toBe(1);
  expect(json.stderr).toBe("");
  expect(JSON.parse(json.stdout).data.serve.canon).toMatchObject({ state: "full", live: 100, archived: 5, ceiling: 100 });
  const text = runCli(setup.env, "doctor");
  expect(text.exitCode).toBe(1);
  expect(text.stdout).toContain("canon pages live=100 archived=5 ceiling=100 state=full");
  expect(text.stdout).toContain("raise max_live_pages under [canon]");
  const query = runCli(setup.env, "query", "synthetic", "--json");
  expect(query.exitCode).toBe(0);
});
