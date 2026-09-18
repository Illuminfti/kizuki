import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function degradedReasons(stdout: string): string[] {
  const report = JSON.parse(stdout) as { degraded?: string[] };
  return report.degraded ?? [];
}

describe("purge keeps the derived index cursor answerable", () => {
  test("a completed purge leaves doctor fresh and query serving", () => {
    const setup = tempVault();
    writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
    writeFileSync(join(setup.notes, "borealis.md"), "Ada keeps the Borealis ledger.\n");
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode,
    ).toBe(0);
    expect(runCli(setup.env, "query", "Borealis", "--json").exitCode).toBe(0);

    const purged = runCli(
      setup.env,
      "purge",
      "--connector",
      "kizuki.markdown-folder",
      "--record",
      "acme.md",
      "--reason",
      "source deleted",
    );
    expect(purged.exitCode).toBe(0);

    const doctor = runCli(setup.env, "doctor", "--json");
    expect(degradedReasons(doctor.stdout)).not.toContain("index-behind-ledger");
    expect(degradedReasons(doctor.stdout)).not.toContain("index-behind-receipts");

    const query = runCli(setup.env, "query", "Borealis", "--json");
    expect(query.stderr).not.toContain("search index is stale");
    expect(query.exitCode).toBe(0);
  }, 120_000);

  test("a verified purge completion leaves doctor fresh and query serving", () => {
    const setup = tempVault();
    writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
    writeFileSync(join(setup.notes, "borealis.md"), "Ada keeps the Borealis ledger.\n");
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode,
    ).toBe(0);

    const purged = runCli(
      setup.env,
      "purge",
      "--connector",
      "kizuki.markdown-folder",
      "--record",
      "acme.md",
      "--reason",
      "source deleted",
    );
    expect(purged.exitCode).toBe(0);
    const receipt = purged.stdout.match(/receipt ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
    expect(receipt).toBeDefined();
    if (receipt === undefined) return;

    const verified = runCli(setup.env, "purge", "--verify", receipt);
    expect(verified.exitCode).toBe(0);

    const doctor = runCli(setup.env, "doctor", "--json");
    expect(degradedReasons(doctor.stdout)).not.toContain("index-behind-ledger");
    expect(degradedReasons(doctor.stdout)).not.toContain("index-behind-receipts");

    const query = runCli(setup.env, "query", "Borealis", "--json");
    expect(query.stderr).not.toContain("search index is stale");
    expect(query.exitCode).toBe(0);
  }, 120_000);
});
