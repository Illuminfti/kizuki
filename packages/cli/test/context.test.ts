import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
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
});
