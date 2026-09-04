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

  test("unset HOME and XDG refuse a relative config path", () => {
    const result = runCli(
      {
        HOME: "",
        XDG_CONFIG_HOME: "",
        KIZUKI_CONFIG: undefined,
      },
      "query",
      "x",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no user config directory");
  });

  test("relative HOME is refused", () => {
    const result = runCli({ HOME: "relative-home", XDG_CONFIG_HOME: "" }, "query", "x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HOME must be an absolute path");
  });

  test("prototype and dotted alias keys are rejected", () => {
    const env = isolatedEnv();
    const path = env.KIZUKI_CONFIG ?? "";
    writeFileSync(
      path,
      `schema = "kizuki.cli.config/v1"\n\n[vaults]\n__proto__ = "/tmp/nope"\n`,
    );
    const proto = runCli(env, "query", "x");
    expect(proto.exitCode).toBe(1);
    expect(proto.stderr).toContain("invalid vault alias");

    writeFileSync(
      path,
      `schema = "kizuki.cli.config/v1"\n\n[vaults]\n"lab.prod" = "/tmp/nope"\n`,
    );
    const dotted = runCli(env, "query", "x");
    expect(dotted.exitCode).toBe(1);
    expect(dotted.stderr).toContain("invalid vault alias");
  });

  test("a stale config lock from a dead pid is stolen", () => {
    const env = isolatedEnv();
    const path = env.KIZUKI_CONFIG ?? "";
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "2147483647\n");
    const vault = join(tempDir(), "lock-vault");
    const result = runCli(env, "init", vault);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(vault);
  });

  test(
    "an empty lock is not stolen until the wait expires",
    () => {
      const env = isolatedEnv();
      const path = env.KIZUKI_CONFIG ?? "";
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.lock`, "");
      const vault = join(tempDir(), "empty-lock-vault");
      const result = runCli(env, "init", vault);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toContain(vault);
    },
    15_000,
  );

  test(
    "a live lock holder is not stolen",
    () => {
      const env = isolatedEnv();
      const path = env.KIZUKI_CONFIG ?? "";
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.lock`, `${process.pid}\n`);
      const result = runCli(env, "init", join(tempDir(), "live-lock-vault"));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("could not lock");
    },
    15_000,
  );

  test("config writes are atomic and round-trip aliases", () => {
    const env = isolatedEnv();
    const first = join(tempDir(), "first");
    expect(runCli(env, "init", first).exitCode).toBe(0);
    const text = readFileSync(env.KIZUKI_CONFIG ?? "", "utf8");
    expect(text).toContain('schema = "kizuki.cli.config/v1"');
    expect(text).toContain("[vaults]");
    expect(text).not.toMatch(/constructor\s*=/);
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
