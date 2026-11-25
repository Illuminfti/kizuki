import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

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
    memt: { mode: string; gpu_backend: string; experiences: number; snapshots: number };
    serve: {
      ok: boolean;
      failures: string[];
      model: { canon_writing: string; model_ref: string | null };
      stores: { vector_layer: { state: string } };
      rails: { rail: string; status: string }[];
    };
  };
}

interface CleanReadEnvelope {
  schema: string;
  status: string;
  degraded: string[];
  warnings: string[];
}

function assertZeroDegradedDoctor(
  env: Record<string, string | undefined>,
  vault: string,
  extraArgs: string[] = [],
): DoctorEnvelope {
  const result = runCli(env, "doctor", "--json", "--vault", vault, ...extraArgs);
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
  expect(existsSync(join(vault, ".kizuki", "memt", "registry.sqlite"))).toBe(false);
  return body;
}

describe("fresh-user doctor truth and zero spurious degraded flags", () => {
  test("a freshly initialized no-model vault has zero degraded flags, zero warnings, and stays read-only", () => {
    const setup = tempVault();
    const markBefore = readFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "utf8");

    const plain = assertZeroDegradedDoctor(setup.env, setup.vault);
    expect(plain.data.serve.rails.every((rail) => rail.status === "idle")).toBe(true);

    assertZeroDegradedDoctor(setup.env, setup.vault, ["--integrity"]);
    expect(readFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "utf8")).toBe(markBefore);
  });

  test("import, serve --once, query, and context keep doctor and read envelopes free of degraded flags", () => {
    const setup = tempVault();
    const imported = runCli(
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

    const served = runCli(setup.env, "serve", "--once", "--no-http", "--vault", setup.vault);
    expect(served.exitCode, served.stderr).toBe(0);
    const afterServe = assertZeroDegradedDoctor(setup.env, setup.vault);
    expect(afterServe.data.serve.rails.every((rail) => rail.status === "ok")).toBe(true);

    const query = runCli(setup.env, "query", "Ada", "--json", "--vault", setup.vault);
    expect(query.exitCode, query.stderr).toBe(0);
    expect(query.stderr).toBe("");
    const queryBody = JSON.parse(query.stdout) as CleanReadEnvelope;
    expect(queryBody).toMatchObject({ schema: "kizuki.cli.query/v1", status: "ok", degraded: [], warnings: [] });

    const context = runCli(setup.env, "context", "--query", "Ada", "--json", "--vault", setup.vault);
    expect(context.exitCode, context.stderr).toBe(0);
    expect(context.stderr).toBe("");
    const contextBody = JSON.parse(context.stdout) as CleanReadEnvelope;
    expect(contextBody).toMatchObject({ schema: "kizuki.cli.context/v1", status: "ok", degraded: [], warnings: [] });
  });

  test("export and snapshot restores produce healthy vaults queryable without --degraded", () => {
    const setup = tempVault();
    const imported = runCli(
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
      const created = runCli(setup.env, kind, "--out", archive, "--vault", setup.vault);
      expect(created.exitCode, created.stderr).toBe(0);
      const verified = runCli(setup.env, "restore", "--from", archive, "--verify");
      expect(verified.exitCode, verified.stderr).toBe(0);
      const recovered = runCli(setup.env, "restore", "--from", archive, "--into", restored);
      expect(recovered.exitCode, recovered.stderr).toBe(0);

      assertZeroDegradedDoctor(setup.env, restored);

      const query = runCli(setup.env, "query", "Ada", "--json", "--vault", restored);
      expect(query.exitCode, query.stderr).toBe(0);
      expect(query.stderr).toBe("");
      const queryBody = JSON.parse(query.stdout) as CleanReadEnvelope;
      expect(queryBody).toMatchObject({ schema: "kizuki.cli.query/v1", status: "ok", degraded: [], warnings: [] });
      expect(query.stdout.toLowerCase()).toContain("ada met grace");

      const context = runCli(setup.env, "context", "--query", "Ada", "--json", "--vault", restored);
      expect(context.exitCode, context.stderr).toBe(0);
      expect(context.stderr).toBe("");
      const contextBody = JSON.parse(context.stdout) as CleanReadEnvelope;
      expect(contextBody).toMatchObject({ schema: "kizuki.cli.context/v1", status: "ok", degraded: [], warnings: [] });
      expect(context.stdout.toLowerCase()).toContain("ada met grace");
    }
  });
});
