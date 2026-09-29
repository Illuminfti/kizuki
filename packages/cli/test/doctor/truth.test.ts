import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyRunTotals, persistRunReceipt } from "@kizuki/core";
import { openLedger } from "@kizuki/core/internal";
import { createHelpers, fixtureConsent } from "../helpers";
import { fakeSystemd } from "../serve/supervisor-fixture";
import { nextStep } from "../../src/commands/doctor-next";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(120_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const MODEL_REF = "kizuki.llm.openai-compatible:loopback@127.0.0.1";

function configuredModel(vault: string): void {
  const serveToml = join(vault, ".kizuki", "serve.toml");
  writeFileSync(
    serveToml,
    '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "http://127.0.0.1:7777/v1"\nmodel = "loopback"\nsecret_ref = "env:MODEL_KEY"\n',
    { mode: 0o600 },
  );
  chmodSync(serveToml, 0o600);
}

function persistSync(
  vault: string,
  n: number,
  overrides: Record<string, unknown>,
): void {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const at = new Date(Date.now() - (10 - n) * 60_000).toISOString();
    persistRunReceipt(db, vault, {
      ...emptyRunTotals(),
      run_id: `01JCLITRUTH${String(n).padStart(15, "0")}`,
      rail: "sync",
      started_at: at,
      finished_at: at,
      status: "degraded",
      stopped: null,
      ...overrides,
    } as never);
  } finally {
    db.close();
  }
}

const truncatedRun = {
  errors: ["model response rejected: response truncated"],
  model: {
    ...emptyRunTotals().model,
    calls: 1,
    model_ref: MODEL_REF,
    last_request: "failed",
    diagnostic: { stage: "response", rule: "response_truncated" },
  },
};

describe("doctor tells the daemon's story from a shell without its secret", () => {
  test("the model line reads receipts under the ref with the host, and next follows the failure", () => {
    const setup = tempVault();
    configuredModel(setup.vault);
    const before = runCli(setup.env, "doctor");
    expect(before.stdout).toContain(
      "canon writing: unverified (model configured but not bound by the running host)",
    );
    for (let n = 1; n <= 4; n += 1) persistSync(setup.vault, n, truncatedRun);

    const result = runCli(setup.env, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(
      /canon writing: configured; daemon last_success=never last_failure=model response rejected: response truncated at \S+ consecutive_failures=4/,
    );
    expect(result.stdout).not.toContain("canon writing: unverified");
    expect(result.stdout).toContain(
      "extraction backlog=0 last_extracted_at=never",
    );
    const json = JSON.parse(runCli(setup.env, "doctor", "--json").stdout) as {
      data: {
        serve: {
          model: { canon_writing: string; consecutive_failures: number };
        };
      };
    };
    expect(json.data.serve.model.canon_writing).toBe("configured");
    expect(json.data.serve.model.consecutive_failures).toBe(4);
  });

  test("a failed doctor never suggests tell, and names a step for the top failure", () => {
    const base = tempVault();
    const setup = { ...base, env: fakeSystemd(base.root, base.env) };
    expect(
      runCli(
        setup.env,
        "import",
        "markdown-folder",
        "--source",
        setup.notes,
        ...fixtureConsent(setup.root),
      ).exitCode,
    ).toBe(0);
    runCli(
      { ...setup.env, KIZUKI_SUPERVISOR: "systemd" },
      "serve",
      "--install",
    );
    const failed = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "masked",
      },
      "doctor",
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("claim ");
    expect(failed.stdout).not.toContain("kizuki tell");
    expect(failed.stdout).toContain(
      "next: follow the serve-failure line above",
    );

    // The same vault without the service is ok, and only then does tell follow.
    const plain = tempVault();
    expect(runCli(plain.env, "import", "markdown-folder", "--source", plain.notes, ...fixtureConsent(plain.root)).exitCode).toBe(0);
    const healthy = runCli(plain.env, "doctor");
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stdout).toContain('next: kizuki tell "<statement>" --claim ');
  });

  test("a source that sends text to a model is listed with host, model and retention", () => {
    const setup = tempVault();
    const connected = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(connected.exitCode, connected.stderr).toBe(0);
    const key = connected.stdout.match(
      /source=([0-9A-HJKMNPQRSTVWXYZ]{26})/,
    )?.[1];
    expect(key).toBeDefined();
    const policy = join(setup.root, "egress-policy.json");
    writeFileSync(
      policy,
      JSON.stringify({
        purposes: ["capture", "recall", "derive", "extract", "export"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: {
          model_endpoint: "https://models.example.test/v1",
          model: "synthetic-model",
          external_retention: "provider_managed",
        },
        sensitivity_floor: "public",
      }),
      { mode: 0o600 },
    );
    const granted = runCli(
      setup.env,
      "connect",
      "grant",
      "--source",
      key!,
      "--policy",
      policy,
      "--expected-revision",
      "0",
      "--operation-id",
      "egress-line",
    );
    expect(granted.exitCode, granted.stderr).toBe(0);
    const result = runCli(setup.env, "doctor");
    expect(result.stdout).toContain(
      `egress source=${key} connector=kizuki.markdown-folder host=models.example.test model=synthetic-model retention=provider_managed`,
    );
  });
});

describe("nextStep", () => {
  const serve = (
    failures: string[],
    hint: string | null = null,
    modelFailure: { detail: string; at: string } | null = null,
  ) =>
    ({
      failures,
      extraction: { hint },
      model: { current_failure: modelFailure },
    }) as never;
  const claims = [{ claim_id: "01JCLAIM" }];

  test("is the correction hint only when the report is ok", () => {
    expect(
      nextStep({
        ok: true,
        serve: serve([]),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toBe('next: kizuki tell "<statement>" --claim 01JCLAIM');
    expect(
      nextStep({
        ok: true,
        serve: serve([]),
        live_claims: [],
        filed_claims: [],
      }),
    ).toBeNull();
  });

  test("follows the top failure when the report failed", () => {
    const model = {
      detail: "model response rejected: response truncated",
      at: "2026-10-01T00:00:00.000Z",
    };
    const failures = [
      `${model.detail} (at ${model.at})`,
      "rail sync: last run failed",
    ];
    expect(
      nextStep({
        ok: false,
        serve: serve(failures, "raise it", model),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toContain("edit .kizuki/serve.toml");
    expect(
      nextStep({
        ok: false,
        serve: serve(failures, null, model),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toContain("model endpoint");
    expect(
      nextStep({
        ok: false,
        serve: serve(["rail brief: stale 999s (period 86400s)"]),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toContain("kizuki serve run brief");
    expect(
      nextStep({
        ok: false,
        serve: serve(["supervisor masked"]),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toContain("serve-failure line");
    expect(
      nextStep({
        ok: false,
        serve: serve([]),
        live_claims: claims,
        filed_claims: [],
      }),
    ).toContain("fix the failure above");
    for (const failing of [[], ["supervisor masked"], ["rail sync: x"]]) {
      expect(
        nextStep({
          ok: false,
          serve: serve(failing),
          live_claims: claims,
          filed_claims: [],
        }),
      ).not.toContain("tell");
    }
  });
});
