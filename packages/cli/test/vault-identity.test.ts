import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir } = createHelpers();
afterEach(cleanup);

describe("vault identity", () => {
  test("a directory is not a vault just because it exists", () => {
    const env = isolatedEnv();
    const decoy = join(tempDir(), "decoy");
    mkdirSync(decoy, { recursive: true });
    const result = runCli({ ...env, KIZUKI_VAULT: decoy }, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault is not initialized");
  });

  test("a .kizuki folder without vault-id is refused", () => {
    const env = isolatedEnv();
    const decoy = join(tempDir(), "half");
    mkdirSync(join(decoy, ".kizuki"), { recursive: true });
    mkdirSync(join(decoy, "archive"), { recursive: true });
    const result = runCli({ ...env, KIZUKI_VAULT: decoy }, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault identity missing");
  });

  test("init writes a vault-id that later commands accept", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "vault");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    const doctor = runCli({ ...env, KIZUKI_VAULT: vault }, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("vault_id=");
  });
});
