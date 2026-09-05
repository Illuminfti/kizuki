import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("first-use sensitivity", () => {
  test("a markdown-folder import is searchable and appears in owner context without a model", () => {
    const setup = tempVault();
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", setup.notes).exitCode,
    ).toBe(0);

    const query = runCli(setup.env, "query", "acme", "--scope", "ledger");
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain("acme");

    const context = runCli(
      setup.env,
      "context",
      "--purpose",
      "session",
      "--budget",
      "600",
    );
    expect(context.exitCode).toBe(0);
    expect(context.stdout).toContain("acme");
  });
});
