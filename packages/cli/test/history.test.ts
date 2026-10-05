import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fixtureConsent } from "./helpers";
import { createHelpers } from "./helpers";

setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

type HistoryData = {
  view: "tree";
  snapshot: string;
  node: { node: string; event_id?: string; children?: { node: string }[] };
  budget_bytes: number;
  coverage: string;
  notice: string;
};

function importedVault() {
  const setup = tempVault();
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);
  return setup;
}

function data(result: { stdout: string }): HistoryData {
  const body = JSON.parse(result.stdout) as { schema: string; data: { data: HistoryData } };
  expect(body.schema).toBe("kizuki.cli.history/v1");
  return body.data.data;
}

describe("history", () => {
  test("documents its bounded public flags", () => {
    const setup = tempVault();
    const help = runCli(setup.env, "history", "--help", "--json");
    expect(help.exitCode).toBe(0);
    const body = JSON.parse(help.stdout) as { data: { name: string; options: string[]; defaults: Record<string, string> } };
    expect(body.data.name).toBe("history");
    expect(body.data.options).toEqual(expect.arrayContaining(["--connector", "--budget", "--snapshot", "--node"]));
    expect(body.data.defaults["--budget"]).toBe("1024");
  });

  test("navigates the same authorized tree from root to child to original event", () => {
    const setup = importedVault();
    const rootResult = runCli(setup.env, "history", "--connector", "kizuki.markdown-folder", "--budget", "128", "--json");
    expect(rootResult.exitCode).toBe(0);
    const root = data(rootResult);
    expect(root.view).toBe("tree");
    expect(root.budget_bytes).toBe(128);
    expect(root.coverage).toContain("first 200 authorized");
    expect(root.notice).toContain("extractive");

    let current = root;
    while (current.node.children !== undefined) {
      const next = runCli(
        setup.env,
        "history",
        "--connector",
        "kizuki.markdown-folder",
        "--snapshot",
        current.snapshot,
        "--node",
        current.node.children[0]!.node,
        "--budget",
        "128",
        "--json",
      );
      expect(next.exitCode).toBe(0);
      current = data(next);
    }
    expect(current.node.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("refuses malformed budgets and incomplete zoom handles without exposing output", () => {
    const setup = importedVault();
    for (const args of [["--budget", "127"], ["--snapshot", "a".repeat(64)]]) {
      const result = runCli(setup.env, "history", ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage: kizuki history");
    }
  });
});
