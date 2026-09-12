import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  "agent",
  "audit",
  "tell",
  "undo",
  "query",
  "context",
  "doctor",
  "serve",
  "purge",
  "export",
  "restore",
  "rebuild",
  "version",
] as const;

describe("help", () => {
  test("COMMANDS retains every implemented non-gate verb", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining([...IMPLEMENTED_NON_GATE_VERBS]),
    );
  });

  test("docs/cli.md documents a usage line for every live command", () => {
    const docs = readFileSync(join(import.meta.dir, "../../../docs/cli.md"), "utf8");
    for (const command of COMMANDS) {
      expect(docs).toContain(`usage: kizuki ${command.name}`);
    }
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
    expect(result.stdout).toContain("usage: kizuki connect [--list|status] [--json]");
    expect(result.stdout).toContain(
      "kizuki connect <connector> --source PATH [--sensitivity public|personal|private]",
    );
    expect(result.stdout).toContain("kizuki connect beeper --token-ref");
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

  test("query --help names defaults, bounds, flags, and exit codes", () => {
    const result = runCli(isolatedEnv(), "query", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: kizuki query <text>");
    expect(result.stdout).toContain("--scope  canon|ledger|all  default all");
    expect(result.stdout).toContain("--limit  1..50  default 20");
    expect(result.stdout).toContain("--degraded");
    expect(result.stdout).toContain("Exit codes");
    expect(result.stdout).toContain("2  usage error");
    expect(result.stdout).not.toContain("Irreversible");
  });

  test("query --help --json emits the command schema", () => {
    const result = runCli(isolatedEnv(), "query", "--help", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      schema: string;
      status: string;
      data: {
        name: string;
        options: string[];
        flags: string[];
        defaults: Record<string, string>;
        bounds: Record<string, string>;
        irreversible: boolean;
        exit_codes: { code: number; meaning: string }[];
      };
    };
    expect(body.schema).toBe("kizuki.cli.help/v1");
    expect(body.status).toBe("ok");
    expect(body.data.name).toBe("query");
    expect(body.data.options).toEqual(["--scope", "--limit"]);
    expect(body.data.flags).toEqual(["--json", "--degraded"]);
    expect(body.data.defaults).toEqual({ "--scope": "all", "--limit": "20" });
    expect(body.data.bounds).toEqual({ "--scope": "canon|ledger|all", "--limit": "1..50" });
    expect(body.data.irreversible).toBe(false);
    expect(body.data.exit_codes.map((item) => item.code)).toEqual([0, 1, 2]);
  });

  test("help purge --json marks selector options irreversible", () => {
    const text = runCli(isolatedEnv(), "purge", "--help");
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Irreversible");
    expect(text.stdout).toContain("--event");
    expect(text.stdout).toContain("--verify");
    const result = runCli(isolatedEnv(), "help", "purge", "--json");
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      data: { name: string; irreversible: boolean; options: string[]; flags: string[] };
    };
    expect(body.data.name).toBe("purge");
    expect(body.data.irreversible).toBe(true);
    expect(body.data.options).toEqual([
      "--event",
      "--subject",
      "--source",
      "--connector",
      "--record",
      "--reason",
      "--verify",
    ]);
    expect(body.data.flags).toContain("--dry-run");
  });

  test("command help --json with extra arguments is usage", () => {
    const result = runCli(isolatedEnv(), "query", "--help", "--json", "extra");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("error: invalid arguments");
    expect(result.stderr).toContain("usage: kizuki query");
  });

  test("tell structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["tell", "--help", "--json"], ["help", "tell", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: {
          name: string;
          options: string[];
          flags: string[];
          bounds: Record<string, string>;
          irreversible: boolean;
        };
      };
      expect(body.data.name).toBe("tell");
      expect(body.data.options).toEqual(["--about", "--claim", "--page", "--since", "--until"]);
      expect(body.data.flags).toEqual(["--dry-run", "--json", "--verbose"]);
      expect(body.data.bounds).toEqual({ "--since": "TIME", "--until": "TIME" });
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "tell", "--help");
    expect(text.stdout).toContain("--claim");
    expect(text.stdout).toContain("--dry-run");
    for (const [args, diagnostic] of [
      [["tell", "the name is Ada", "--nope"], "unknown option --nope"],
      [["tell", "the name is Ada", "--json", "--json"], "repeated flag --json"],
      [["tell", "the name is Ada", "--json=true"], "flag --json does not take a value"],
      [["tell", "the name is Ada", "--claim"], "missing value for --claim"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki tell");
    }
  });

  test("undo structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["undo", "--help", "--json"], ["help", "undo", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("undo");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual(["--cascade"]);
      expect(body.data.irreversible).toBe(false);
    }
    expect(runCli(env, "undo", "--help").stdout).toContain("--cascade");
    for (const [args, diagnostic] of [
      [["undo", "01JCRECEIPT000000000000000", "--nope"], "unknown option --nope"],
      [["undo", "01JCRECEIPT000000000000000", "--cascade", "--cascade"], "repeated flag --cascade"],
      [["undo", "01JCRECEIPT000000000000000", "--cascade=true"], "flag --cascade does not take a value"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki undo");
    }
  });

  test("doctor structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["doctor", "--help", "--json"], ["help", "doctor", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("doctor");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual(["--json", "--integrity"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "doctor", "--help");
    expect(text.stdout).toContain("--json");
    expect(text.stdout).toContain("--integrity");
    for (const [args, diagnostic] of [
      [["doctor", "--nope"], "unknown option --nope"],
      [["doctor", "--json", "--json"], "repeated flag --json"],
      [["doctor", "--integrity", "--integrity"], "repeated flag --integrity"],
      [["doctor", "--json=true"], "flag --json does not take a value"],
      [["doctor", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki doctor");
    }
  });

  test("export structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["export", "--help", "--json"], ["help", "export", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("export");
      expect(body.data.options).toEqual(["--out"]);
      expect(body.data.flags).toEqual([]);
      expect(body.data.irreversible).toBe(false);
    }
    expect(runCli(env, "export", "--help").stdout).toContain("--out");
    for (const [args, diagnostic] of [
      [["export", "--nope"], "unknown option --nope"],
      [["export", "--out", "./export", "--out", "./other"], "repeated option --out"],
      [["export", "--out"], "missing value for --out"],
      [["export", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki export");
    }
  });

  test("restore structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["restore", "--help", "--json"], ["help", "restore", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("restore");
      expect(body.data.options).toEqual(["--from", "--into"]);
      expect(body.data.flags).toEqual(["--verify"]);
      expect(body.data.irreversible).toBe(false);
    }
    expect(runCli(env, "restore", "--help").stdout).toContain("--from");
    expect(runCli(env, "restore", "--help").stdout).toContain("--verify");
    for (const [args, diagnostic] of [
      [["restore", "--nope"], "unknown option --nope"],
      [["restore", "--verify", "--verify"], "repeated flag --verify"],
      [["restore", "--verify=true"], "flag --verify does not take a value"],
      [["restore", "--from"], "missing value for --from"],
      [["restore", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki restore");
    }
  });

  test("context structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["context", "--help", "--json"], ["help", "context", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: {
          name: string;
          options: string[];
          flags: string[];
          defaults: Record<string, string>;
          bounds: Record<string, string>;
          irreversible: boolean;
        };
      };
      expect(body.data.name).toBe("context");
      expect(body.data.options).toEqual(["--purpose", "--budget", "--query"]);
      expect(body.data.flags).toEqual(["--json"]);
      expect(body.data.defaults).toEqual({ "--purpose": "session" });
      expect(body.data.bounds).toEqual({
        "--purpose": "session|recall|correction|audit",
        "--budget": "50..2000",
      });
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "context", "--help");
    expect(text.stdout).toContain("--purpose  session|recall|correction|audit  default session");
    expect(text.stdout).toContain("--budget  50..2000");
    for (const [args, diagnostic] of [
      [["context", "--nope"], "unknown option --nope"],
      [["context", "--json", "--json"], "repeated flag --json"],
      [["context", "--json=true"], "flag --json does not take a value"],
      [["context", "--purpose"], "missing value for --purpose"],
      [["context", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki context");
    }
  });

  test("audit structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["audit", "--help", "--json"], ["help", "audit", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: {
          name: string;
          options: string[];
          flags: string[];
          defaults: Record<string, string>;
          bounds: Record<string, string>;
          irreversible: boolean;
        };
      };
      expect(body.data.name).toBe("audit");
      expect(body.data.options).toEqual(["--since", "--page", "--writer", "--limit", "--offset"]);
      expect(body.data.flags).toEqual(["--contested", "--ambiguous", "--reverted", "--json", "--list"]);
      expect(body.data.defaults).toEqual({ "--limit": "5000", "--offset": "0" });
      expect(body.data.bounds).toEqual({ "--since": "TIME", "--limit": "1..5000", "--offset": "N" });
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "audit", "--help");
    expect(text.stdout).toContain("--since  TIME");
    expect(text.stdout).toContain("--limit  1..5000  default 5000");
    expect(text.stdout).toContain("--contested");
    for (const [args, diagnostic] of [
      [["audit", "--nope"], "unknown option --nope"],
      [["audit", "--json", "--json"], "repeated flag --json"],
      [["audit", "--list=true"], "flag --list does not take a value"],
      [["audit", "--since"], "missing value for --since"],
      [["audit", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki audit");
    }
  });

  test("rebuild structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["rebuild", "--help", "--json"], ["help", "rebuild", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: {
          name: string;
          options: string[];
          flags: string[];
          defaults: Record<string, string>;
          bounds: Record<string, string>;
          irreversible: boolean;
        };
      };
      expect(body.data.name).toBe("rebuild");
      expect(body.data.options).toEqual(["--layer", "--port"]);
      expect(body.data.flags).toEqual(["--json", "--prune-old"]);
      expect(body.data.defaults).toEqual({ "--layer": "all" });
      expect(body.data.bounds).toEqual({ "--layer": "all|graph" });
      expect(body.data.irreversible).toBe(false);
    }
    expect(runCli(env, "rebuild", "--help").stdout).toContain("--layer  all|graph  default all");
    expect(runCli(env, "rebuild", "--help").stdout).toContain("--prune-old");
    for (const [args, diagnostic] of [
      [["rebuild", "--nope"], "unknown option --nope"],
      [["rebuild", "--json", "--json"], "repeated flag --json"],
      [["rebuild", "--prune-old=true"], "flag --prune-old does not take a value"],
      [["rebuild", "--port"], "missing value for --port"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki rebuild");
    }
    const extra = runCli(env, "rebuild", "extra");
    expect(extra.exitCode).toBe(2);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toContain("error: rebuild supports --layer all or graph");
    expect(extra.stderr).toContain("usage: kizuki rebuild");
  });

  test("app structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["app", "--help", "--json"], ["help", "app", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("app");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual(["--no-open", "--no-service"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "app", "--help");
    expect(text.stdout).toContain("--no-open");
    expect(text.stdout).toContain("--no-service");
    for (const [args, diagnostic] of [
      [["app", "--nope"], "unknown option --nope"],
      [["app", "--no-open", "--no-open"], "repeated flag --no-open"],
      [["app", "--no-service", "--no-service"], "repeated flag --no-service"],
      [["app", "--no-open=true"], "flag --no-open does not take a value"],
      [["app", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki app");
    }
  });

  test("backfill structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["backfill", "--help", "--json"], ["help", "backfill", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("backfill");
      expect(body.data.options).toEqual(["--source"]);
      expect(body.data.flags).toEqual([]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "backfill", "--help");
    expect(text.stdout).toContain("--source");
    for (const [args, diagnostic] of [
      [["backfill", "markdown-folder", "--nope"], "unknown option --nope"],
      [["backfill", "markdown-folder", "--source", "a", "--source", "b"], "repeated option --source"],
      [["backfill", "markdown-folder", "--source"], "missing value for --source"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki backfill");
    }
  });

  test("init structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["init", "--help", "--json"], ["help", "init", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("init");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual([
        "--default",
        "--no-default",
        "--no-service",
        "--adopt",
        "--dry-run",
      ]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "init", "--help");
    expect(text.stdout).toContain("--default");
    expect(text.stdout).toContain("--no-service");
    expect(text.stdout).toContain("--adopt");
    expect(text.stdout).toContain("--dry-run");
    for (const [args, diagnostic] of [
      [["init", "./vault", "--nope"], "unknown option --nope"],
      [["init", "./vault", "--dry-run", "--dry-run"], "repeated flag --dry-run"],
      [["init", "./vault", "--no-service=true"], "flag --no-service does not take a value"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki init");
    }
  });

  test("sync structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["sync", "--help", "--json"], ["help", "sync", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("sync");
      expect(body.data.options).toEqual(["--source"]);
      expect(body.data.flags).toEqual(["--once"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "sync", "--help");
    expect(text.stdout).toContain("--source");
    expect(text.stdout).toContain("--once");
    for (const [args, diagnostic] of [
      [["sync", "--nope"], "unknown option --nope"],
      [["sync", "--once", "--once"], "repeated flag --once"],
      [["sync", "--once=true"], "flag --once does not take a value"],
      [["sync", "--source"], "missing value for --source"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki sync");
    }
  });

  test("agent structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["agent", "--help", "--json"], ["help", "agent", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("agent");
      expect(body.data.options).toEqual(["--grant", "--token-ref", "--operation-id"]);
      expect(body.data.flags).toEqual(["--dry-run", "--json"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "agent", "--help");
    expect(text.stdout).toContain("--grant");
    expect(text.stdout).toContain("--token-ref");
    expect(text.stdout).toContain("--operation-id");
    expect(text.stdout).toContain("--dry-run");
    expect(text.stdout).toContain("--json");
    for (const args of [
      ["agent", "add", "--nope"],
      ["agent", "add", "assistant", "--dry-run", "--dry-run"],
      ["agent", "add", "--dry-run=true"],
      ["agent", "add", "--grant"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid_request:");
      expect(result.stderr).toContain("usage: agent");
    }
  });

  test("import structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["import", "--help", "--json"], ["help", "import", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("import");
      expect(body.data.options).toEqual([
        "--source",
        "--authorization",
        "--policy",
        "--expected-revision",
        "--operation-id",
      ]);
      expect(body.data.flags).toEqual(["--dry-run", "--json"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "import", "--help");
    expect(text.stdout).toContain("--source");
    expect(text.stdout).toContain("--authorization");
    expect(text.stdout).toContain("--policy");
    expect(text.stdout).toContain("--dry-run");
    for (const [args, diagnostic] of [
      [["import", "markdown-folder", "--nope"], "unknown option --nope"],
      [["import", "estate-slice", "--dry-run", "--dry-run"], "repeated flag --dry-run"],
      [["import", "estate-slice", "--json=true"], "flag --json does not take a value"],
      [["import", "markdown-folder", "--source"], "missing value for --source"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki import");
    }
  });

  test("models structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["models", "--help", "--json"], ["help", "models", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("models");
      expect(body.data.options).toEqual(["--from", "--sha256", "--bytes"]);
      expect(body.data.flags).toEqual(["--catalog"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "models", "--help");
    expect(text.stdout).toContain("--from");
    expect(text.stdout).toContain("--sha256");
    expect(text.stdout).toContain("--bytes");
    expect(text.stdout).toContain("--catalog");
    for (const [args, diagnostic] of [
      [["models", "list", "--nope"], "unknown option --nope"],
      [["models", "list", "--catalog", "--catalog"], "repeated flag --catalog"],
      [["models", "list", "--catalog=true"], "flag --catalog does not take a value"],
      [["models", "pull", "--from"], "missing value for --from"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki models");
    }
  });

  test("serve structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["serve", "--help", "--json"], ["help", "serve", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("serve");
      expect(body.data.options).toEqual([
        "--port",
        "--crash-after",
        "--service-custody",
        "--custody-broker-launch",
        "--custody-broker-child",
      ]);
      expect(body.data.flags).toEqual(["--once", "--no-http", "--json", "--install", "--uninstall"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "serve", "--help");
    expect(text.stdout).toContain("--port");
    expect(text.stdout).toContain("--once");
    expect(text.stdout).toContain("--no-http");
    expect(text.stdout).toContain("--install");
    for (const [args, diagnostic] of [
      [["serve", "--nope"], "unknown option --nope"],
      [["serve", "--once", "--once"], "repeated flag --once"],
      [["serve", "--json=true"], "flag --json does not take a value"],
      [["serve", "--port"], "missing value for --port"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki serve");
    }
  });

  test("connect structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["connect", "--help", "--json"], ["help", "connect", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("connect");
      expect(body.data.options).toEqual([
        "--source",
        "--sensitivity",
        "--endpoint",
        "--token-ref",
        "--fields",
        "--calendar",
        "--history-start",
      ]);
      expect(body.data.flags).toEqual(["--list", "--json", "--new-source"]);
      expect(body.data.irreversible).toBe(false);
    }
    const text = runCli(env, "connect", "--help");
    expect(text.stdout).toContain("--source");
    expect(text.stdout).toContain("--token-ref");
    expect(text.stdout).toContain("--json");
    expect(text.stdout).toContain("--new-source");
    for (const [args, diagnostic] of [
      [["connect", "--nope"], "unknown option --nope"],
      [["connect", "--json", "--json"], "repeated flag --json"],
      [["connect", "--list=true"], "flag --list does not take a value"],
      [["connect", "--source"], "missing value for --source"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki connect");
    }
  });

  test("recover structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["recover", "--help", "--json"], ["help", "recover", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("recover");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual(["--json"]);
      expect(body.data.irreversible).toBe(false);
    }
    expect(runCli(env, "recover", "--help").stdout).toContain("--json");
    for (const [args, diagnostic] of [
      [["recover", "--nope"], "unknown option --nope"],
      [["recover", "--json", "--json"], "repeated flag --json"],
      [["recover", "--json=true"], "flag --json does not take a value"],
      [["recover", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki recover");
    }
  });

  test("version structured help matches its parser", () => {
    const env = isolatedEnv();
    for (const args of [["version", "--help", "--json"], ["help", "version", "--json"]] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout) as {
        data: { name: string; options: string[]; flags: string[]; irreversible: boolean };
      };
      expect(body.data.name).toBe("version");
      expect(body.data.options).toEqual([]);
      expect(body.data.flags).toEqual([]);
      expect(body.data.irreversible).toBe(false);
    }
    for (const [args, diagnostic] of [
      [["version", "--nope"], "unknown option --nope"],
      [["version", "--json"], "unknown option --json"],
      [["version", "extra"], "invalid arguments"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).toContain("usage: kizuki version");
    }
  });
});
