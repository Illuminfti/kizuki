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
      'usage: kizuki tell "<statement>" [--about SUBJECT] [--claim CLAIM_ID]',
    );
  });

  test("help <verb> prints that verb's usage", () => {
    const result = runCli(isolatedEnv(), "help", "connect");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "usage: kizuki connect <connector> --source PATH",
    );
  });

  test("version prints the package version field", () => {
    const result = runCli(isolatedEnv(), "version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.1.0\n");
  });
});
