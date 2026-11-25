import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RAIL_IDS } from "@kizuki/core";
import { CLI_CHILD_TIMEOUT_MS, fixtureConsent, type CliResult } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const mainPath = resolve(import.meta.dir, "../../src/main.ts");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * Strictly isolated fresh-user environment: never inherits host `KIZUKI_*`
 * settings (such as `KIZUKI_MEMT_URL`, model endpoints, or credentials).
 */
function freshEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    KIZUKI_CONFIG: join(root, "config.toml"),
    KIZUKI_SUPERVISOR: "none",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
  };
}

function runFreshCli(env: Record<string, string>, ...args: string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, mainPath, ...args], {
    env,
    cwd: process.cwd(),
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: CLI_CHILD_TIMEOUT_MS,
  });
  if (result.exitedDueToTimeout === true) {
    throw new Error(`kizuki ${args[0] ?? ""} did not exit within ${CLI_CHILD_TIMEOUT_MS} ms`);
  }
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function freshVault(): {
  env: Record<string, string>;
  notes: string;
  root: string;
  vault: string;
} {
  const root = mkdtempSync(join(tmpdir(), "kizuki-fresh-doctor-"));
  directories.push(root);
  const vault = join(root, "vault");
  const notes = join(root, "notes");
  const env = freshEnv(root);
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "ada.md"), "ada met grace at the acme library\n", "utf8");
  const init = runFreshCli(env, "init", vault, "--no-service");
  if (init.exitCode !== 0) {
    throw new Error(`freshVault init failed: ${init.stderr}`);
  }
  return { env, notes, root, vault };
}

interface DoctorRail {
  rail: string;
  status: string;
  last_result: string | null;
  reason: string | null;
  degraded_streak: number;
}

interface DoctorEnvelope {
  schema: string;
  status: string;
  degraded: string[];
  warnings: string[];
  data: {
    ok: boolean;
    problems: unknown[];
    ledger: { ok: boolean; quick_check: string };
    effective_config: { model_ref: string | null };
    connections: { connector_id: string; health: string; problem: string | null }[];
    memt: {
      mode: string;
      gpu_backend: string;
      gpu_configured: boolean;
      endpoint_host: string | null;
      model: string | null;
      experiences: number;
      snapshots: number;
    };
    serve: {
      ok: boolean;
      failures: string[];
      model: { canon_writing: string; model_ref: string | null };
      stores: { vector_layer: { state: string } };
      rails: DoctorRail[];
    };
  };
}

interface CleanReadEnvelope {
  schema: string;
  status: string;
  degraded: string[];
  warnings: string[];
  data?: {
    data?: {
      packet_md?: string;
    };
  };
}

function assertZeroDegradedDoctor(
  env: Record<string, string>,
  vault: string,
  extraArgs: string[] = [],
): DoctorEnvelope {
  const result = runFreshCli(env, "doctor", "--json", "--vault", vault, ...extraArgs);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const body = JSON.parse(result.stdout) as DoctorEnvelope;
  expect(body.schema).toBe("kizuki.cli.doctor/v1");
  expect(body.status).toBe("ok");
  expect(body.degraded).toEqual([]);
  expect(body.warnings).toEqual([]);
  expect(body.data.ok).toBe(true);
  expect(body.data.problems).toEqual([]);
  expect(body.data.ledger.ok).toBe(true);
  expect(body.data.ledger.quick_check).toBe("ok");
  expect(body.data.effective_config.model_ref).toBeNull();
  expect(body.data.serve.ok).toBe(true);
  expect(body.data.serve.failures).toEqual([]);
  expect(body.data.serve.model.canon_writing).toBe("off");
  expect(body.data.serve.model.model_ref).toBeNull();
  expect(body.data.serve.stores.vector_layer.state).toBe("off");
  expect(body.data.memt.mode).toBe("local-hybrid");
  expect(body.data.memt.gpu_backend).toBe("offline");
  expect(body.data.memt.gpu_configured).toBe(false);
  expect(body.data.memt.endpoint_host).toBeNull();
  expect(body.data.memt.model).toBeNull();
  expect(existsSync(join(vault, ".kizuki", "memt", "registry.sqlite"))).toBe(false);
  return body;
}

function assertExpectedRails(
  rails: readonly DoctorRail[],
  expectedStatus: "idle" | "ok",
  expectedLastResult: null | "ok",
): void {
  expect(RAIL_IDS.length).toBeGreaterThan(0);
  expect(
    rails.map((rail) => ({
      rail: rail.rail,
      status: rail.status,
      last_result: rail.last_result,
      reason: rail.reason,
      degraded_streak: rail.degraded_streak,
    })),
  ).toEqual(
    RAIL_IDS.map((rail) => ({
      rail,
      status: expectedStatus,
      last_result: expectedLastResult,
      reason: null,
      degraded_streak: 0,
    })),
  );
}

describe("fresh-user doctor truth and zero spurious degraded flags", () => {
  test("a freshly initialized no-model vault has zero degraded flags, zero warnings, expected idle rails, and stays read-only", () => {
    const setup = freshVault();
    const markBefore = readFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "utf8");

    const plain = assertZeroDegradedDoctor(setup.env, setup.vault);
    assertExpectedRails(plain.data.serve.rails, "idle", null);

    assertZeroDegradedDoctor(setup.env, setup.vault, ["--integrity"]);
    expect(readFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "utf8")).toBe(markBefore);
  });

  test("fresh-user initialization and doctor do not inherit host KIZUKI_MEMT_* environment variables", () => {
    const saved = {
      KIZUKI_MEMT_URL: process.env.KIZUKI_MEMT_URL,
      KIZUKI_MEMT_API_KEY: process.env.KIZUKI_MEMT_API_KEY,
      KIZUKI_MEMT_MODEL: process.env.KIZUKI_MEMT_MODEL,
    };
    process.env.KIZUKI_MEMT_URL = "http://127.0.0.1:9";
    process.env.KIZUKI_MEMT_API_KEY = "synthetic-host-key";
    process.env.KIZUKI_MEMT_MODEL = "memt-pro";
    try {
      const setup = freshVault();
      expect(setup.env.KIZUKI_MEMT_URL).toBeUndefined();
      expect(setup.env.KIZUKI_MEMT_API_KEY).toBeUndefined();
      expect(setup.env.KIZUKI_MEMT_MODEL).toBeUndefined();
      const report = assertZeroDegradedDoctor(setup.env, setup.vault);
      assertExpectedRails(report.data.serve.rails, "idle", null);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("import, serve --once, query, and context keep doctor, rails, and rendered packets free of degraded flags", () => {
    const setup = freshVault();
    const imported = runFreshCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
      ...fixtureConsent(setup.root),
    );
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(imported.stderr).toBe("");

    const afterImport = assertZeroDegradedDoctor(setup.env, setup.vault);
    expect(afterImport.data.connections).toHaveLength(1);
    expect(afterImport.data.connections[0]).toMatchObject({
      connector_id: "kizuki.markdown-folder",
      health: "ok",
      problem: null,
    });

    const served = runFreshCli(setup.env, "serve", "--once", "--no-http", "--vault", setup.vault);
    expect(served.exitCode, served.stderr).toBe(0);
    const afterServe = assertZeroDegradedDoctor(setup.env, setup.vault);
    assertExpectedRails(afterServe.data.serve.rails, "ok", "ok");

    const query = runFreshCli(setup.env, "query", "Ada", "--json", "--vault", setup.vault);
    expect(query.exitCode, query.stderr).toBe(0);
    expect(query.stderr).toBe("");
    const queryBody = JSON.parse(query.stdout) as CleanReadEnvelope;
    expect(queryBody).toMatchObject({ schema: "kizuki.cli.query/v1", status: "ok", degraded: [], warnings: [] });

    const context = runFreshCli(setup.env, "context", "--query", "Ada", "--json", "--vault", setup.vault);
    expect(context.exitCode, context.stderr).toBe(0);
    expect(context.stderr).toBe("");
    const contextBody = JSON.parse(context.stdout) as CleanReadEnvelope;
    expect(contextBody).toMatchObject({ schema: "kizuki.cli.context/v1", status: "ok", degraded: [], warnings: [] });
    expect(contextBody.data?.data?.packet_md?.toLowerCase()).toContain("ada met grace at the acme library");
  });

  test("export and snapshot restores produce healthy vaults with rendered context packets queryable without --degraded", () => {
    const setup = freshVault();
    const imported = runFreshCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
      ...fixtureConsent(setup.root),
    );
    expect(imported.exitCode, imported.stderr).toBe(0);

    for (const kind of ["export", "backup"] as const) {
      const archive = join(setup.root, `${kind}-out`);
      const restored = join(setup.root, `${kind}-restored`);
      const created = runFreshCli(setup.env, kind, "--out", archive, "--vault", setup.vault);
      expect(created.exitCode, created.stderr).toBe(0);
      const verified = runFreshCli(setup.env, "restore", "--from", archive, "--verify");
      expect(verified.exitCode, verified.stderr).toBe(0);
      const recovered = runFreshCli(setup.env, "restore", "--from", archive, "--into", restored);
      expect(recovered.exitCode, recovered.stderr).toBe(0);

      assertZeroDegradedDoctor(setup.env, restored);

      const query = runFreshCli(setup.env, "query", "Ada", "--json", "--vault", restored);
      expect(query.exitCode, query.stderr).toBe(0);
      expect(query.stderr).toBe("");
      const queryBody = JSON.parse(query.stdout) as CleanReadEnvelope;
      expect(queryBody).toMatchObject({ schema: "kizuki.cli.query/v1", status: "ok", degraded: [], warnings: [] });
      expect(query.stdout.toLowerCase()).toContain("ada met grace");

      const context = runFreshCli(setup.env, "context", "--query", "Ada", "--json", "--vault", restored);
      expect(context.exitCode, context.stderr).toBe(0);
      expect(context.stderr).toBe("");
      const contextBody = JSON.parse(context.stdout) as CleanReadEnvelope;
      expect(contextBody).toMatchObject({ schema: "kizuki.cli.context/v1", status: "ok", degraded: [], warnings: [] });
      expect(contextBody.data?.data?.packet_md?.toLowerCase()).toContain("ada met grace at the acme library");
    }
  });
});
