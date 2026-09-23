import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault, isolatedEnv, tempDir } = createHelpers();
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

  test.each([
    "", "8080junk", "1.5", "1e3", "0x10", "-1", "+80", " 80", "80 ",
    "80\n", "80\r", "80\u2028", "80\u2029", "65536", "999999999999999999999",
  ])("invalid port %j is a usage error before opening a vault", (port) => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "missing-vault");
    const result = runCli(env, "serve", "--once", "--no-http", "--port", port, "--vault", vault);
    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: kizuki serve");
    expect(existsSync(vault)).toBe(false);
  });

  test.each(["0", "65535"])("decimal boundary port %s remains accepted with HTTP disabled", (port) => {
    const setup = tempVault();
    const result = runCli(setup.env, "serve", "--once", "--no-http", "--port", port, "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.http).toBeNull();
  });

  test("run brief writes a dashboard file without a review queue", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "serve", "run", "brief");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rail=brief");
  });
});
