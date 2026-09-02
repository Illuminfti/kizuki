import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

describe("config", () => {
  test("no vault configured prints the exact init hint", () => {
    const result = runCli(isolatedEnv(), "query", "x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "error: no vault configured; run: kizuki init <path>\n",
    );
  });

  test("KIZUKI_CONFIG beats XDG_CONFIG_HOME beats HOME", () => {
    const root = tempDir();
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    const explicit = join(root, "explicit.toml");
    mkdirSync(join(home, ".config", "kizuki"), { recursive: true });
    mkdirSync(join(xdg, "kizuki"), { recursive: true });
    writeFileSync(
      join(home, ".config", "kizuki", "config.toml"),
      `default_vault = "${join(root, "from-home")}"\n\n[vaults]\n`,
    );
    writeFileSync(
      join(xdg, "kizuki", "config.toml"),
      `default_vault = "${join(root, "from-xdg")}"\n\n[vaults]\n`,
    );
    writeFileSync(
      explicit,
      `default_vault = "${join(root, "from-explicit")}"\n\n[vaults]\n`,
    );

    const viaExplicit = runCli(
      {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        KIZUKI_CONFIG: explicit,
      },
      "query",
      "x",
    );
    expect(viaExplicit.stderr).toContain(join(root, "from-explicit"));

    const viaXdg = runCli({ HOME: home, XDG_CONFIG_HOME: xdg }, "query", "x");
    expect(viaXdg.stderr).toContain(join(root, "from-xdg"));

    const viaHome = runCli({ HOME: home }, "query", "x");
    expect(viaHome.stderr).toContain(join(root, "from-home"));
  });

  test("--vault name looks up config.vaults", () => {
    const setup = tempVault();
    const other = join(setup.root, "named-vault");
    expect(runCli(setup.env, "init", other, "--no-default").exitCode).toBe(0);
    writeFileSync(
      setup.env.KIZUKI_CONFIG ?? "",
      `default_vault = ${JSON.stringify(setup.vault)}\n\n[vaults]\nlab = ${JSON.stringify(other)}\n`,
    );
    const result = runCli(setup.env, "doctor", "--vault", "lab");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`vault=${other}`);
  });

  test("KIZUKI_VAULT selects the vault when no --vault is set", () => {
    const setup = tempVault();
    const other = join(setup.root, "env-vault");
    expect(runCli(setup.env, "init", other, "--no-default").exitCode).toBe(0);
    const result = runCli({ ...setup.env, KIZUKI_VAULT: other }, "doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`vault=${other}`);
  });

  test("refuses to rewrite a config that has an unknown key", () => {
    const env = isolatedEnv();
    const path = env.KIZUKI_CONFIG ?? "";
    const original = `default_vault = "/tmp/original"\nllm = "nope"\n\n[vaults]\n`;
    writeFileSync(path, original);
    const result = runCli(env, "init", join(tempDir(), "vault"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown key llm");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("init sets default_vault once and --default overrides", () => {
    const env = isolatedEnv();
    const first = join(tempDir(), "first");
    const second = join(tempDir(), "second");
    const third = join(tempDir(), "third");

    const initial = runCli(env, "init", first);
    expect(initial.exitCode).toBe(0);
    expect(initial.stdout).toContain(
      `default_vault set in ${env.KIZUKI_CONFIG}`,
    );

    const again = runCli(env, "init", second);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain("default_vault set");
    expect(readFileSync(env.KIZUKI_CONFIG ?? "", "utf8")).toContain(first);
    expect(readFileSync(env.KIZUKI_CONFIG ?? "", "utf8")).not.toContain(second);

    const override = runCli(env, "init", third, "--default");
    expect(override.exitCode).toBe(0);
    expect(override.stdout).toContain("default_vault set");
    expect(readFileSync(env.KIZUKI_CONFIG ?? "", "utf8")).toContain(third);
  });

  test("--default and --no-default together is a usage error", () => {
    const result = runCli(
      isolatedEnv(),
      "init",
      join(tempDir(), "vault"),
      "--default",
      "--no-default",
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: kizuki init");
  });
});
