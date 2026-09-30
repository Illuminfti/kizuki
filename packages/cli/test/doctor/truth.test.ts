import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyRunTotals, persistRunReceipt } from "@kizuki/core";
import { openLedger } from "@kizuki/core/internal";
import { createHelpers, fixtureConsent } from "../helpers";
import { fakeSystemd } from "../serve/supervisor-fixture";
import { nextStep } from "../../src/commands/doctor-next";
import { RETENTION_MEANING } from "../../src/egress-view";

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

  for (const retention of ["provider_managed", "zero_retention", "logged_no_training", "logged_and_trained"] as const) test(`a source that sends text to a model is listed with host, model and ${retention}`, () => {
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
          external_retention: retention,
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
      `egress source=${key} connector=kizuki.markdown-folder host=models.example.test model=synthetic-model retention=${retention} (${RETENTION_MEANING[retention]})`,
    );
  });

  test("a configured judge the grant does not name is reported as a hold, and named it is not", () => {
    const setup = tempVault();
    const connected = runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes);
    expect(connected.exitCode, connected.stderr).toBe(0);
    const key = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
    writeFileSync(join(setup.vault, ".kizuki", "serve.toml"),
      '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "https://models.example.test/v1"\nmodel = "synthetic-model"\n[ports.systemone]\nid = "kizuki.systemone.jev"\nbase_url = "https://judge.example.test/v1"\nmodel = "synthetic-judge"\n', { mode: 0o600 });
    const egress = { model_endpoint: "https://models.example.test/v1/chat/completions", model: "synthetic-model", external_retention: "provider_managed" };
    const grant = (value: object, expected: number) => {
      const policy = join(setup.root, `judge-policy-${expected}.json`);
      writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "derive", "extract"], allowed_fields: ["text"], retention: "persistent_owned_until_revoked", egress: value, sensitivity_floor: "public" }), { mode: 0o600 });
      const granted = runCli(setup.env, "connect", "grant", "--source", key, "--policy", policy, "--expected-revision", String(expected), "--operation-id", `judge-${expected}`);
      expect(granted.exitCode, granted.stderr).toBe(0);
    };
    grant(egress, 0);
    expect(runCli(setup.env, "doctor").stdout).toContain(`egress source=${key} judge host=judge.example.test model=synthetic-judge retention=logged_and_trained (undeclared); held: judge not consented`);
    grant({ ...egress, judge_endpoint: "https://judge.example.test/v1/systemone", judge_model: "synthetic-judge" }, 1);
    const named = runCli(setup.env, "doctor").stdout;
    expect(named).toContain(`egress source=${key} connector=kizuki.markdown-folder host=models.example.test`);
    expect(named).toContain(`egress source=${key} judge host=judge.example.test model=synthetic-judge retention=logged_and_trained (undeclared)`);
    expect(named).not.toContain("held: judge not consented");
  });
});

describe("nextStep", () => {
  type Top = { kind: "model" | "rail" | "service" | "other"; rail: string | null } | null;
  const serve = (top: Top, hint: string | null = null) =>
    ({
      // The hint reads the structured top failure, never the failure text.
      failures: ["worded however the report words it"],
      top_failure: top,
      extraction: { hint },
    }) as never;
  const claims = [{ claim_id: "01JCLAIM" }];
  const failed = (top: Top, hint: string | null = null) =>
    nextStep({ ok: false, serve: serve(top, hint), live_claims: claims, filed_claims: [] });

  test("is the correction hint only when the report is ok", () => {
    expect(
      nextStep({ ok: true, serve: serve(null), live_claims: claims, filed_claims: [] }),
    ).toBe('next: kizuki tell "<statement>" --claim 01JCLAIM');
    expect(
      nextStep({ ok: true, serve: serve(null), live_claims: [], filed_claims: [] }),
    ).toBeNull();
  });

  test("follows the structured top failure when the report failed", () => {
    expect(failed({ kind: "model", rail: null }, "raise it")).toContain("edit .kizuki/serve.toml");
    expect(failed({ kind: "model", rail: null })).toContain("model endpoint");
    expect(failed({ kind: "service", rail: null })).toContain("serve-failure line");
    expect(failed({ kind: "other", rail: null })).toContain("fix the failure above");
    expect(failed(null)).toContain("fix the failure above");
  });

  test("a down rail points at read-only diagnostics, never at running the rail", () => {
    const step = failed({ kind: "rail", rail: "brief" });
    expect(step).toContain("rail brief is down");
    expect(step).toContain("kizuki serve status");
    expect(step).not.toContain("serve run");
  });

  test("a failed report never suggests a correction", () => {
    for (const top of [null, { kind: "service", rail: null }, { kind: "rail", rail: "sync" }, { kind: "model", rail: null }] as Top[]) {
      expect(failed(top)).not.toContain("tell");
    }
  });
});
