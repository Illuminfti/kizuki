import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("kizuki serve", () => {
  test("help lists the serve verb", () => {
    const setup = tempVault();
    const help = runCli(setup.env, "help", "serve");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("usage: kizuki serve");
  });

  test("--once --no-http writes run receipts and exits 0", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "serve", "--once", "--no-http", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"receipts":');
    const status = runCli(setup.env, "serve", "status", "--json");
    expect(status.stdout).toContain("supervisor");
  });

  test("run brief writes a dashboard file without a review queue", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "serve", "run", "brief");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rail=brief");
  });
});
