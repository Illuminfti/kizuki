import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureGguf } from "@kizuki/embed-gguf";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

describe("kizuki models pull", () => {
  test("copies a local GGUF into the vault models directory", () => {
    const setup = tempVault();
    const source = join(setup.root, "fixture.gguf");
    const bytes = writeFixtureGguf();
    writeFileSync(source, bytes);

    const result = runCli(setup.env, "models", "pull", "--from", source);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`path=${setup.vault}/.kizuki/models/fixture.gguf`);
    expect(result.stdout).toContain("bytes=");
    expect(result.stdout).toContain("sha256=");
    expect(result.stdout).toContain("space=gguf:kizuki-fixture-embed@8");
    expect(existsSync(join(setup.vault, ".kizuki", "models", "fixture.gguf"))).toBe(
      true,
    );
    expect(
      readFileSync(join(setup.vault, ".kizuki", "models", "fixture.gguf")),
    ).toEqual(Buffer.from(bytes));
  });

  test("without --from refuses to download and exits 2", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "models", "pull");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not download weights");
    expect(result.stderr).toContain("usage: kizuki models pull --from PATH");
  });

  test("unknown models verb exits 2", () => {
    const result = runCli(isolatedEnv(), "models", "fetch");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: kizuki models pull --from PATH");
  });

  test("hash mismatch fails closed", () => {
    const setup = tempVault();
    const source = join(tempDir(), "fixture.gguf");
    writeFileSync(source, writeFixtureGguf());
    const result = runCli(
      setup.env,
      "models",
      "pull",
      "--from",
      source,
      "--sha256",
      "0".repeat(64),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match expected sha256");
  });
});
