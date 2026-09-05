import { fixtureConsent } from "./helpers";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConfiguredRetrieval } from "../src/retrieval-runtime";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("a busy optional engine preserves recall and daemon controls while required bindings refuse", async () => {
  const f = tempVault();
  expect(runCli(f.env, "import", "markdown-folder", "--source", f.notes, ...fixtureConsent(f.root)).exitCode).toBe(0);
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
  const retrieval = await openConfiguredRetrieval(f.vault);
  expect(retrieval).toBeDefined();
  try {
    const query = runCli(f.env, "query", "Acme", "--json");
    expect(query.exitCode).toBe(0);
    const queryResult = JSON.parse(query.stdout);
    expect(queryResult.degraded).toContain("retrieval-unavailable");
    expect(queryResult.data.hits.map((hit: { snippet: string }) => hit.snippet).join("\n")).toContain("ada met grace at the acme library");
    for (const args of [["--query", "Acme"], []]) {
      const packet = runCli(f.env, "context", ...args, "--json");
      expect(packet.exitCode).toBe(0);
      expect(JSON.parse(packet.stdout).degraded).toContain("retrieval-unavailable");
    }
    const doctor = runCli(f.env, "doctor", "--json");
    expect(() => JSON.parse(doctor.stdout)).not.toThrow();
    expect(doctor.stderr).not.toContain("writer lease");
    const stop = runCli(f.env, "serve", "stop");
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("serve is not running");
    const start = runCli(f.env, "serve", "--once", "--no-http");
    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain("writer lease");
    // A failed second bind and control commands leave the first host's lease intact.
    expect((await retrieval!.health()).status).toBe("ready");
  } finally { await retrieval?.close(); }
}, 30_000);

test("optional recall does not turn invalid retrieval selection into a healthy floor", () => {
  const f = tempVault();
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.missing"\n');
  const query = runCli(f.env, "query", "Acme", "--json");
  expect(query.exitCode).toBe(1);
  expect(query.stdout).toBe("");
  expect(query.stderr).toContain("not registered");
});
