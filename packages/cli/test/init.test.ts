import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir } = createHelpers();
afterEach(cleanup);

describe("init", () => {
  test("writes owner-only control files and a ready journal", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "vault");
    const previous = process.umask(0o000);
    let result;
    try {
      result = runCli(env, "init", vault, "--no-service");
    } finally {
      process.umask(previous);
    }
    expect(result.exitCode).toBe(0);
    expect(statSync(join(vault, ".kizuki")).mode & 0o777).toBe(0o700);
    expect(statSync(join(vault, ".kizuki", "kizuki.db")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toContain("kizuki.doctrine/v2");
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).not.toContain("reviewed Markdown");
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8"))).toMatchObject({
      schema: "kizuki.init/v1",
      status: "ready",
    });
  });

  test("refuses a non-empty directory and adopts only when asked", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "notes");
    mkdirSync(vault);
    writeFileSync(join(vault, "inbox.md"), "a personal note\n");

    const refused = runCli(env, "init", vault, "--no-service");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --adopt to take ownership");
    expect(refused.stderr).toContain("entry inbox.md");
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);

    const dry = runCli(env, "init", vault, "--adopt", "--dry-run", "--no-service");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry-run");
    expect(dry.stdout).toContain("entry inbox.md");
    expect(existsSync(join(vault, ".kizuki"))).toBe(false);

    const adopted = runCli(env, "init", vault, "--adopt", "--no-service");
    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain("adopt entries=1");
    expect(existsSync(join(vault, ".kizuki", "kizuki.db"))).toBe(true);
    expect(readFileSync(join(vault, "inbox.md"), "utf8")).toBe("a personal note\n");
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8")).adopt.policy).toBe(
      "adopt",
    );
  });

  test("later commands refuse an insecure control directory", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "open");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    chmodSync(join(vault, ".kizuki"), 0o755);
    const doctor = runCli({ ...env, KIZUKI_VAULT: vault }, "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stderr).toContain("not owner-only");
  });

  test("repeated init converges after a partial journal", () => {
    const env = isolatedEnv();
    const vault = join(tempDir(), "again");
    expect(runCli(env, "init", vault, "--no-service").exitCode).toBe(0);
    writeFileSync(
      join(vault, ".kizuki", "init.json"),
      `${JSON.stringify({
        schema: "kizuki.init/v1",
        status: "in_progress",
        doctrine_version: 2,
        adopt: null,
      })}\n`,
    );
    const again = runCli(env, "init", vault, "--no-service", "--no-default");
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(vault, ".kizuki", "init.json"), "utf8")).status).toBe(
      "ready",
    );
    expect(runCli({ ...env, KIZUKI_VAULT: vault }, "doctor").exitCode).toBe(0);
  });
});
