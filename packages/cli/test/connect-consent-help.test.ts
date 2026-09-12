import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fixtureConsent, createHelpers } from "./helpers";
import {
  CONNECT_GRANT_SCHEMA,
  CONNECT_RESUME_SCHEMA,
  CONNECT_REVOKE_SCHEMA,
} from "../src/option-schema";

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const ACTIONS = [
  {
    action: "grant",
    schema: CONNECT_GRANT_SCHEMA,
    usage:
      "connect grant --source KEY --policy FILE --expected-revision N --operation-id ID [--json]",
    irreversible: false,
  },
  {
    action: "revoke",
    schema: CONNECT_REVOKE_SCHEMA,
    usage: "connect revoke --source KEY --expected-revision N --operation-id ID [--json]",
    irreversible: false,
  },
  {
    action: "resume-revocation",
    schema: CONNECT_RESUME_SCHEMA,
    usage: "connect resume-revocation --source KEY --operation-id ID [--json]",
    irreversible: true,
  },
] as const;

function helpJson(stdout: string) {
  return JSON.parse(stdout) as {
    schema: string;
    status: string;
    data: {
      name: string;
      usage: string;
      options: string[];
      flags: string[];
      defaults: Record<string, string>;
      bounds: Record<string, string>;
      irreversible: boolean;
      examples: string[];
    };
  };
}

describe("connect consent help", () => {
  test("grant, revoke, and resume-revocation --help name accepted options without a vault", () => {
    const env = isolatedEnv();
    for (const { action, schema, usage, irreversible } of ACTIONS) {
      for (const args of [
        ["connect", action, "--help"],
        ["connect", "--help", action],
        ["help", "connect", action],
      ] as const) {
        const result = runCli(env, ...args);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`usage: kizuki ${usage}`);
        for (const option of schema.options) expect(result.stdout).toContain(option);
        for (const [option, bound] of Object.entries(schema.bounds)) {
          expect(result.stdout).toContain(`${option}  ${bound}`);
        }
        expect(result.stdout).toContain("--json");
        expect(result.stdout).toContain("Exit codes");
        if (irreversible) {
          expect(result.stdout).toContain("Irreversible");
          expect(result.stdout).toContain(
            "Physical event deletion cannot be undone. Canon rewrites stay reversible by receipt.",
          );
        } else {
          expect(result.stdout).not.toContain("Irreversible");
        }
        expect(result.stdout).not.toContain("--token-ref");
        expect(result.stdout).not.toContain("--new-source");
        expect(result.stdout).not.toContain("--endpoint");
        if (action !== "grant") expect(result.stdout).not.toMatch(/^\s+--policy\b/m);
        if (action === "resume-revocation") {
          expect(result.stdout).not.toContain("--expected-revision");
        }
      }
    }
  });

  test("command-specific --help --json emits the matching option schema", () => {
    const env = isolatedEnv();
    for (const { action, schema, usage, irreversible } of ACTIONS) {
      for (const args of [
        ["connect", action, "--help", "--json"],
        ["help", "connect", action, "--json"],
        ["help", "--json", "connect", action],
      ] as const) {
        const result = runCli(env, ...args);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const body = helpJson(result.stdout);
        expect(body.schema).toBe("kizuki.cli.help/v1");
        expect(body.status).toBe("ok");
        expect(body.data.name).toBe(`connect ${action}`);
        expect(body.data.usage).toBe(usage);
        expect(body.data.options).toEqual([...schema.options]);
        expect(body.data.flags).toEqual([...schema.flags]);
        expect(body.data.defaults).toEqual({});
        expect(body.data.bounds).toEqual({ ...schema.bounds });
        expect(body.data.irreversible).toBe(irreversible);
        expect(body.data.examples).toEqual([]);
      }
    }
  });

  test("resume-revocation help matches purge irreversibility; grant and revoke stay reversible", () => {
    const env = isolatedEnv();
    const purgeText = runCli(env, "purge", "--help");
    const resumeText = runCli(env, "connect", "resume-revocation", "--help");
    expect(purgeText.exitCode).toBe(0);
    expect(resumeText.exitCode).toBe(0);
    expect(purgeText.stdout).toContain("Irreversible");
    expect(resumeText.stdout).toContain("Irreversible");
    const purgeJson = JSON.parse(runCli(env, "help", "purge", "--json").stdout) as {
      data: { name: string; irreversible: boolean };
    };
    const resumeJson = helpJson(runCli(env, "help", "connect", "resume-revocation", "--json").stdout);
    expect(purgeJson.data.name).toBe("purge");
    expect(purgeJson.data.irreversible).toBe(true);
    expect(resumeJson.data.name).toBe("connect resume-revocation");
    expect(resumeJson.data.irreversible).toBe(true);
    for (const action of ["grant", "revoke"] as const) {
      expect(runCli(env, "connect", action, "--help").stdout).not.toContain("Irreversible");
      expect(helpJson(runCli(env, "help", "connect", action, "--json").stdout).data.irreversible).toBe(
        false,
      );
    }
    const parent = helpJson(runCli(env, "help", "connect", "--json").stdout);
    expect(parent.data.name).toBe("connect");
    expect(parent.data.irreversible).toBe(false);
  });

  test("unknown consent options, repeated flags, and extra tokens fail before work", () => {
    const env = isolatedEnv();
    for (const [args, diagnostic] of [
      [["connect", "grant", "--nope"], "unknown option --nope"],
      [["connect", "grant", "--list"], "unknown option --list"],
      [["connect", "grant", "--new-source"], "unknown option --new-source"],
      [["connect", "revoke", "--policy", "policy.json"], "unknown option --policy"],
      [["connect", "resume-revocation", "--expected-revision", "0"], "unknown option --expected-revision"],
      [["connect", "resume-revocation", "--policy", "policy.json"], "unknown option --policy"],
      [["connect", "grant", "--json", "--json"], "repeated flag --json"],
      [["connect", "revoke", "--json=true"], "flag --json does not take a value"],
      [["connect", "resume-revocation", "--source"], "missing value for --source"],
      [["connect", "grant", "extra"], "invalid arguments"],
      [["connect", "grant", "--help", "extra"], "invalid arguments"],
      [["connect", "not-a-consent-command", "--help"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki connect");
    }
    const nested = runCli(env, "help", "connect", "not-a-consent-command");
    expect(nested.exitCode).toBe(2);
    expect(nested.stdout).toBe("");
    expect(nested.stderr).toContain("error: invalid arguments");
    expect(nested.stderr).toContain("usage: kizuki help [verb] [--json]");
  });

  test("grant, revoke, and resume-revocation validate required options before vault work", () => {
    const env = isolatedEnv();
    const source = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (const [args, diagnostic] of [
      [["connect", "grant", "--source", source, "--expected-revision", "0", "--operation-id", "grant-1"], "connect grant requires --policy FILE"],
      [["connect", "grant", "--source", source, "--policy", "policy.json", "--operation-id", "grant-1"], "--expected-revision requires an exact nonnegative integer"],
      [["connect", "revoke", "--source", source, "--expected-revision", "1"], "--operation-id requires a unique identifier (1-128 ASCII letters, digits, _, ., :, -)"],
      [["connect", "resume-revocation", "--source", source, "--operation-id", "complete:resume"], "--operation-id requires a unique identifier (1-128 ASCII letters, digits, _, ., :, -)"],
      [["connect", "grant", "--source", "not-a-key", "--policy", "policy.json", "--expected-revision", "0", "--operation-id", "grant-1"], "connect consent requires --source KEY"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki connect");
    }
  });

  test("consent help does not enroll, grant, or write vault state", () => {
    const setup = tempVault();
    const connected = runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes);
    expect(connected.exitCode).toBe(0);
    const key = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)?.[1];
    expect(key).toBeDefined();
    const before = runCli(setup.env, "connect", "status", "--source", key!, "--json");
    expect(before.exitCode).toBe(0);
    expect(JSON.parse(before.stdout).data.grant).toBeNull();
    const connections = join(setup.vault, ".kizuki", "connections");
    const beforeEntries = readdirSync(connections).sort();

    for (const action of ["grant", "revoke", "resume-revocation"] as const) {
      const help = runCli(
        setup.env,
        "connect",
        action,
        "--help",
        "--source",
        key!,
        ...fixtureConsent(setup.root, "help-must-not-run"),
      );
      expect(help.exitCode).toBe(2);
      expect(help.stdout).toBe("");
      expect(help.stderr).toContain("error: invalid arguments");
      const text = runCli(setup.env, "connect", action, "--help");
      expect(text.exitCode).toBe(0);
      expect(text.stderr).toBe("");
    }

    const after = runCli(setup.env, "connect", "status", "--source", key!, "--json");
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.stdout).data.grant).toBeNull();
    expect(readdirSync(connections).sort()).toEqual(beforeEntries);
  });
});
