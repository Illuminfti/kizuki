import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeEndpoint } from "../../llm/test/fake-endpoint";
import type { FakeEndpoint } from "../../llm/test/fake-endpoint";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
const endpoints: FakeEndpoint[] = [];

afterEach(() => {
  while (endpoints.length > 0) endpoints.pop()?.stop();
  cleanup();
});

function fake(): FakeEndpoint {
  const endpoint = startFakeEndpoint();
  endpoints.push(endpoint);
  return endpoint;
}

const LOOPBACK = "http://127.0.0.1:11434/v1";
const CLOSED = "http://127.0.0.1:9/v1";

describe("kizuki llm set", () => {
  test("writes an owner-only file and show reads it back", () => {
    const { env, vault } = tempVault();
    const set = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      LOOPBACK,
      "--model",
      "a-model",
    );
    expect(set.exitCode).toBe(0);
    expect(set.stdout.trim()).toBe(
      "llm host=127.0.0.1:11434 model=a-model api_key=none cloud=false ceiling=personal unlabeled=skip json_mode=true timeout_ms=60000 rpm=30 max_requests=60",
    );
    expect(statSync(join(vault, ".kizuki", "llm.toml")).mode & 0o777).toBe(
      0o600,
    );
    expect(runCli(env, "--vault", vault, "llm", "show").stdout.trim()).toBe(
      set.stdout.trim(),
    );
  });

  test("a later set changes one knob and keeps the rest", () => {
    const { env, vault } = tempVault();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      LOOPBACK,
      "--model",
      "a-model",
    );
    const changed = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--unlabeled",
      "send",
    );
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout).toContain("unlabeled=send");
    expect(changed.stdout).toContain("model=a-model");
  });

  test("a remote endpoint needs consent and https, and nothing is written until it has both", () => {
    const { env, vault } = tempVault();
    const refused = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      "http://example.invalid/v1",
      "--model",
      "m",
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("error: llm cloud_not_allowed:");
    expect(runCli(env, "--vault", vault, "llm", "show").stdout.trim()).toBe(
      "llm unconfigured",
    );

    const insecure = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      "http://example.invalid/v1",
      "--model",
      "m",
      "--allow-cloud-inference",
    );
    expect(insecure.exitCode).toBe(1);
    expect(insecure.stderr).toContain("error: llm insecure_remote:");

    const allowed = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      "https://example.invalid/v1",
      "--model",
      "m",
      "--allow-cloud-inference",
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("cloud=true");
  });

  test("a pasted key is refused and never echoed", () => {
    const { env, vault } = tempVault();
    const canary = "sk-not-a-ref-9f3b";
    const refused = runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
      "--api-key",
      canary,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("error: llm plaintext_key:");
    expect(refused.stderr).not.toContain(canary);
    expect(refused.stdout).not.toContain(canary);
  });

  test("a secret reference is stored as a reference, never a value", () => {
    const canary = "sk-canary-8a2e11";
    const { env, vault } = tempVault();
    const withKey = { ...env, KIZUKI_CLI_TEST_KEY: canary };
    runCli(
      withKey,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
      "--api-key",
      "env:KIZUKI_CLI_TEST_KEY",
    );
    const json = runCli(withKey, "--vault", vault, "llm", "show", "--json");
    const config = JSON.parse(json.stdout) as { api_key_ref: string };
    expect(config.api_key_ref).toBe("env:KIZUKI_CLI_TEST_KEY");
    expect(json.stdout).not.toContain(canary);
    expect(
      readFileSync(join(vault, ".kizuki", "llm.toml"), "utf8"),
    ).not.toContain(canary);
  });

  test("contradictory flags are a usage error", () => {
    const { env, vault } = tempVault();
    expect(
      runCli(
        env,
        "--vault",
        vault,
        "llm",
        "set",
        "--base-url",
        CLOSED,
        "--model",
        "m",
        "--json-mode",
        "--no-json-mode",
      ).exitCode,
    ).toBe(2);
  });

  test("show on an unconfigured vault is not an error", () => {
    const { env, vault } = tempVault();
    const human = runCli(env, "--vault", vault, "llm", "show");
    expect(human).toMatchObject({ exitCode: 0, stdout: "llm unconfigured\n" });
    expect(
      runCli(env, "--vault", vault, "llm", "show", "--json"),
    ).toMatchObject({ exitCode: 0, stdout: "null\n" });
  });

  test("unset is idempotent", () => {
    const { env, vault } = tempVault();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(runCli(env, "--vault", vault, "llm", "unset")).toMatchObject({
        exitCode: 0,
        stdout: "llm unconfigured\n",
      });
    }
  });
});

describe("kizuki llm test", () => {
  test("reaches a live loopback endpoint", async () => {
    const endpoint = fake();
    const { env, vault } = tempVault();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      endpoint.base_url,
      "--model",
      "a-model",
    );
    // Spawned asynchronously: this process serves the endpoint the child calls.
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/main.ts"),
        "--vault",
        vault,
        "llm",
        "test",
      ],
      {
        env: { ...process.env, ...env } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      `ok host=127.0.0.1:${new URL(endpoint.base_url).port}`,
    );
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.path).toBe("/v1/chat/completions");
  });

  test("fails closed against a closed port", () => {
    const { env, vault } = tempVault();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
    );
    const probe = runCli(env, "--vault", vault, "llm", "test");
    expect(probe.exitCode).toBe(1);
    expect(probe.stderr).toContain("error: llm network:");
  });

  test("refuses to probe an unconfigured vault", () => {
    const { env, vault } = tempVault();
    const probe = runCli(env, "--vault", vault, "llm", "test");
    expect(probe.exitCode).toBe(1);
    expect(probe.stderr).toContain("error: llm unconfigured:");
  });
});

describe("kizuki enrich", () => {
  function seeded(): {
    env: Record<string, string | undefined>;
    vault: string;
  } {
    const { env, notes, vault } = tempVault();
    writeFileSync(
      join(notes, "ada.md"),
      [
        "ada met grace at the acme library to plan the kettle project.",
        "linus asked for a second review before acme signs anything at all.",
        "grace agreed to write the review notes and send them on friday.",
        "acme wants the kettle project finished before the library reopens.",
        "ada said the kettle project needs one more week of quiet work.",
      ].join(" "),
    );
    const imported = runCli(
      env,
      "--vault",
      vault,
      "import",
      "markdown-folder",
      "--source",
      notes,
    );
    expect(imported.exitCode).toBe(0);
    return { env, vault };
  }

  test("refuses to run without a configured endpoint", () => {
    const { env, vault } = tempVault();
    const result = runCli(env, "--vault", vault, "enrich");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "error: no model endpoint configured; run: kizuki llm set --base-url URL --model NAME",
    );
    expect(result.stdout).toBe("");
  });

  test("fails closed when the configured key does not resolve", () => {
    const { env, vault } = seeded();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
      "--api-key",
      "env:KIZUKI_CLI_ABSENT_KEY",
    );
    const result = runCli(env, "--vault", vault, "enrich");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: llm missing_key:");
    expect(result.stderr).toContain("env:KIZUKI_CLI_ABSENT_KEY");
  });

  test("a dry run counts the work and contacts nothing", () => {
    const endpoint = fake();
    const { env, vault } = seeded();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      endpoint.base_url,
      "--model",
      "m",
    );
    const skipped = runCli(env, "--vault", vault, "enrich", "--dry-run");
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain("would_send=0");
    expect(skipped.stdout).toContain("skipped_unlabeled=3");

    runCli(env, "--vault", vault, "llm", "set", "--unlabeled", "send");
    const included = runCli(env, "--vault", vault, "enrich", "--dry-run");
    expect(included.stdout).toContain("would_send=3");
    expect(included.stdout).toContain("requests_estimate=");
    expect(endpoint.requests).toHaveLength(0);
  });

  test("an unknown producer, limit or timestamp is a usage error", () => {
    const { env, vault } = tempVault();
    for (const args of [
      ["--producers", "bogus"],
      ["--limit", "0"],
      ["--limit", "nope"],
    ]) {
      expect(runCli(env, "--vault", vault, "enrich", ...args).exitCode).toBe(2);
    }
  });

  test("reports every failed request, exits non-zero, and doctor shows the run", () => {
    const { env, vault } = seeded();
    runCli(
      env,
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      CLOSED,
      "--model",
      "m",
      "--unlabeled",
      "send",
    );
    const result = runCli(env, "--vault", vault, "enrich");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("requests=3");
    expect(result.stdout).toContain("errors=3");
    expect(result.stdout).toContain("stopped=consecutive_errors");
    for (const producer of ["summary", "entities", "claims"]) {
      expect(result.stderr).toContain(`producer=${producer}`);
    }
    expect(result.stderr).toContain("error: llm network event=");

    const doctor = runCli(env, "--vault", vault, "doctor");
    const line = doctor.stdout
      .split("\n")
      .find((entry) => entry.startsWith("llm "));
    expect(line).toContain("llm host=127.0.0.1:9 model=m last_run=");
    expect(line).toContain("stopped=consecutive_errors");

    const json = runCli(env, "--vault", vault, "doctor", "--json");
    const report = JSON.parse(json.stdout) as {
      llm: { host: string; stopped: string };
    };
    expect(report.llm).toMatchObject({
      host: "127.0.0.1:9",
      model: "m",
      stopped: "consecutive_errors",
    });
  });
});

describe("kizuki doctor and the model producer", () => {
  test("says so when nothing is configured", () => {
    const { env, vault } = tempVault();
    const doctor = runCli(env, "--vault", vault, "doctor");
    expect(doctor.stdout).toContain("llm unconfigured");
    const json = runCli(env, "--vault", vault, "doctor", "--json");
    expect((JSON.parse(json.stdout) as { llm: unknown }).llm).toBeNull();
  });

  test("names an unreadable config as a problem and fails", () => {
    const { env, vault } = tempVault();
    writeFileSync(join(vault, ".kizuki", "llm.toml"), "base_url = [[[\n");
    const doctor = runCli(env, "--vault", vault, "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain("llm problem: malformed_config");
  });
});

describe("the whole owner loop", () => {
  test("drafts, promotes and does not pay twice", async () => {
    const endpoint = fake();
    const { env, vault } = ((): {
      env: Record<string, string | undefined>;
      vault: string;
    } => {
      const built = tempVault();
      writeFileSync(
        join(built.notes, "ada.md"),
        [
          "ada met grace at the acme library to plan the kettle project.",
          "linus asked for a second review before acme signs anything at all.",
          "grace agreed to write the review notes and send them on friday.",
          "acme wants the kettle project finished before the library reopens.",
          "ada said the kettle project needs one more week of quiet work.",
        ].join(" "),
      );
      return built;
    })();

    const main = join(import.meta.dir, "../src/main.ts");
    const spawnEnv = { ...process.env, ...env } as Record<string, string>;
    const run = async (
      ...args: string[]
    ): Promise<{
      code: number;
      out: string;
      err: string;
    }> => {
      const child = Bun.spawn([process.execPath, main, ...args], {
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, out, err };
    };

    expect(
      (
        await run(
          "--vault",
          vault,
          "import",
          "markdown-folder",
          "--source",
          join(vault, "..", "notes"),
        )
      ).code,
    ).toBe(0);
    await run(
      "--vault",
      vault,
      "llm",
      "set",
      "--base-url",
      endpoint.base_url,
      "--model",
      "m",
      "--unlabeled",
      "send",
    );

    const first = await run(
      "--vault",
      vault,
      "enrich",
      "--producers",
      "summary,entities",
    );
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/proposals=[1-9]/);

    const listed = await run("--vault", vault, "review", "--list", "--json");
    const rows = listed.out
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) => JSON.parse(line) as { proposal_id: string; producer: string },
      );
    const draft = rows.find((row) => row.producer === "llm");
    expect(draft).toBeDefined();

    const promoted = await run(
      "--vault",
      vault,
      "promote",
      draft?.proposal_id ?? "",
      "--sensitivity",
      "personal",
    );
    expect(promoted.code).toBe(0);
    const pagePath = (promoted.out.match(/page_path=(\S+)/)?.[1] ?? "").trim();
    expect(pagePath).not.toBe("");
    expect(readFileSync(pagePath, "utf8")).toContain('x-producer: "llm"');

    const second = await run(
      "--vault",
      vault,
      "enrich",
      "--producers",
      "summary,entities",
    );
    expect(second.out).toContain("requests=0");
    expect(second.out).toContain("proposals=0");
    expect(second.out).toMatch(/skipped_done=[1-9]/);
  });
});
