import { afterEach, describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/commands/index";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli } = createHelpers();
afterEach(cleanup);

const IMPLEMENTED_NON_GATE_VERBS = [
  "init",
  "connect",
  "backfill",
  "sync",
  "import",
  "models",
  "audit",
  "tell",
  "undo",
  "query",
  "doctor",
  "serve",
  "purge",
  "export",
  "version",
] as const;

describe("help", () => {
  test("COMMANDS retains every implemented non-gate verb", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining([...IMPLEMENTED_NON_GATE_VERBS]),
    );
  });

  test("help and --help print every non-gate verb to stdout and exit 0", () => {
    const env = isolatedEnv();
    for (const flag of ["help", "--help"] as const) {
      const result = runCli(env, flag);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      for (const verb of IMPLEMENTED_NON_GATE_VERBS) {
        expect(result.stdout).toContain(verb);
      }
    }
  });

  test("no verb prints help on stderr and exits 2", () => {
    const result = runCli(isolatedEnv());
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: kizuki <verb> [options]");
    for (const verb of IMPLEMENTED_NON_GATE_VERBS) {
      expect(result.stderr).toContain(verb);
    }
  });

  test("unknown and legacy alias verbs exit 2", () => {
    const env = isolatedEnv();
    for (const verb of ["ingest", "proposals", "not-a-verb"]) {
      const result = runCli(env, verb);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`unknown verb: ${verb}`);
      expect(result.stderr).toContain("usage: kizuki <verb> [options]");
    }
  });

  test("help exposes the undo-audit RFC 0002 verbs", () => {
    const env = isolatedEnv();
    const result = runCli(env, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("audit");
    expect(result.stdout).toContain("undo");
    expect(runCli(env, "help", "audit").stdout).toContain(
      "usage: kizuki audit [--since TIME] [--page PATH] [--writer NAME]",
    );
    expect(runCli(env, "help", "undo").stdout).toContain(
      "usage: kizuki undo <receipt_id> [--cascade]",
    );
  });

  test("help exposes the correction RFC 0002 verb", () => {
    const env = isolatedEnv();
    const result = runCli(env, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tell");
    expect(runCli(env, "help", "tell").stdout).toContain(
      'usage: kizuki tell "<statement>" [--claim CLAIM_ID]',
    );
  });

  test("help <verb> prints that verb's usage", () => {
    const result = runCli(isolatedEnv(), "help", "connect");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "usage: kizuki connect <connector> --source PATH [--sensitivity public|personal|private]",
    );
  });

  test("root help is a product front door without RFC jargon or live retired verbs", () => {
    const result = runCli(isolatedEnv(), "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Kizuki — local-first LifeOS");
    expect(result.stdout).toContain("bun packages/cli/src/main.ts");
    expect(result.stdout).toContain("Global options");
    expect(result.stdout).toContain("--vault");
    expect(result.stdout).toContain("Examples");
    expect(result.stdout).toContain("docs/cli.md");
    expect(result.stdout).not.toContain("RFC 0002");
    expect(result.stdout).not.toContain("RFC 0000");
    expect(result.stdout).not.toMatch(/^\s+review\s{2}/m);
    expect(result.stdout).not.toMatch(/^\s+promote\s{2}/m);
    expect(result.stdout).not.toMatch(/^\s+reject\s{2}/m);
    expect(result.stdout).toContain("review, promote, reject are retired");
  });

  test("retired owner-gate verbs exit 2 and point at audit, undo, and tell", () => {
    const env = isolatedEnv();
    for (const verb of ["review", "promote", "reject"] as const) {
      const result = runCli(env, verb);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${verb} is retired`);
      expect(result.stderr).toContain("kizuki audit");
      expect(result.stderr).toContain("kizuki undo");
      expect(result.stderr).toContain("kizuki tell");
      expect(runCli(env, "help", verb).exitCode).toBe(2);
    }
  });

  test("usage errors print the reason and point at per-verb help", () => {
    const result = runCli(isolatedEnv(), "query", "acme", "--nope");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("error: unknown option --nope");
    expect(result.stderr).toContain("usage: kizuki query");
    expect(result.stderr).toContain("bun packages/cli/src/main.ts help query");
  });

  test("version prints the package version field", () => {
    const result = runCli(isolatedEnv(), "version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.1.0\n");
  });
});
