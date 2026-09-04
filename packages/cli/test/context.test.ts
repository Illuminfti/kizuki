import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { cleanup, runCli, tempVault, isolatedEnv } = createHelpers();
afterEach(cleanup);

describe("context", () => {
  test("prints a purpose-scoped packet with the machine header", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "context", "--purpose", "session", "--budget", "80");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KIZUKI CONTEXT v1");
    expect(result.stdout).toContain("purpose=session");
    expect(result.stdout).toContain("budget=80");
    expect(result.stdout).toContain("rules=canon lines are produced prose");
  });

  test("help lists the context verb", () => {
    const result = runCli(tempVault().env, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("context");
  });

  test("invalid budgets are usage errors before a vault is opened", () => {
    for (const budget of ["no", "49", "2001", "1.5"]) {
      const result = runCli(isolatedEnv(), "context", "--budget", budget);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("invalid --budget");
      expect(result.stderr).not.toContain("no vault configured");
    }
  });

  test("empty context keeps stdout usable and offers a next step on stderr", () => {
    const result = runCli(tempVault().env, "context");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("KIZUKI CONTEXT v1");
    expect(result.stderr).toContain("No matching context");
  });

  test("corrupt canon is reported as degraded with a failing exit status", () => {
    const setup = tempVault();
    mkdirSync(join(setup.vault, "facts"), { recursive: true });
    writeFileSync(join(setup.vault, "facts", "broken.md"), "no frontmatter here\n");
    const result = runCli(setup.env, "context", "--json");
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe("degraded");
    expect(result.stderr).toContain("could not be gathered completely");
    expect(output.data.data.packet_md).toStartWith("KIZUKI CONTEXT v1");
  });

  test("per-command help works without opening a vault", () => {
    const result = runCli(isolatedEnv(), "connect", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("connect beeper --token-ref");
    expect(result.stdout).toContain("connect status --json");
  });
});
