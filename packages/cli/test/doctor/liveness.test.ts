import { fixtureConsent } from "../helpers";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";
import { fakeSystemd } from "../serve/supervisor-fixture";

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
function supervisedVault() {
  const setup = tempVault();
  return { ...setup, env: fakeSystemd(setup.root, setup.env) };
}
afterEach(cleanup);

describe("doctor liveness", () => {
  test("doctor prints the fixed legacy identity degradation", () => {
    const setup = supervisedVault();
    const result = runCli(setup.env, "doctor");
    expect(result.stdout).toContain("identity authority: unavailable");
  });

  test("a masked or absent unit for an enabled vault is a failure", () => {
    const setup = supervisedVault();
    const installed = runCli(
      { ...setup.env, KIZUKI_SUPERVISOR: "systemd" },
      "serve",
      "--install",
    );
    expect(installed.exitCode).toBe(0);
    const masked = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "masked",
      },
      "doctor",
      "--json",
    );
    expect(masked.exitCode).toBe(1);
    expect(masked.stdout).toContain("masked");

    const absent = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "absent",
      },
      "doctor",
      "--json",
    );
    expect(absent.exitCode).toBe(1);
    expect(absent.stdout).toContain("absent");
  });

  test("a deliberately disabled service is reported without failing", () => {
    const setup = supervisedVault();
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opted-out");
  });

  test("a rail with five empty runs in a row is reported down", () => {
    const setup = supervisedVault();
    for (let index = 0; index < 5; index += 1) {
      const ran = runCli(setup.env, "serve", "run", "sync", "--json");
      expect(ran.exitCode).toBe(0);
    }
    const doctor = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "active",
      },
      "doctor",
    );
    // Intent is still opted-out from tempVault, so empty rails are idle, not down.
    // Install first so the vault expects liveness.
    runCli({ ...setup.env, KIZUKI_SUPERVISOR: "systemd" }, "serve", "--install");
    const live = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "active",
      },
      "doctor",
    );
    expect(live.exitCode).toBe(1);
    expect(live.stdout).toContain("empty streak");
  });

  test("doctor reports canon writing off with no model configured", () => {
    const setup = supervisedVault();
    const result = runCli(setup.env, "doctor");
    expect(result.stdout).toContain(
      "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)",
    );
    expect(result.stdout).toContain("claims live=");
    expect(result.stdout).toContain("filed=");
    expect(result.stdout).toContain("written=");
    expect(result.stdout).toContain("unwritten=");
    expect(result.stdout).toContain("derived search=");
    expect(result.stdout).toContain("writers loop=0 correction=0 import=0 revert=0");
    expect(result.stdout).toContain("origin machine=0 human=0");
    expect(result.stdout).toContain("calibration write_rate=-");
    expect(result.exitCode).toBe(0);
  });

  test("doctor reports an unverified configured model rather than a write-enabled string", () => {
    const setup = supervisedVault();
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nmodel = "synthetic@local"\n',
    );
    const result = runCli(setup.env, "doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "canon writing: unverified (model configured but not bound by the running host)",
    );
  });

  test("doctor does not call a model with an unresolved configured secret bound", () => {
    const setup = supervisedVault();
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "http://127.0.0.1:7777/v1"\nmodel = "loopback"\nsecret_ref = "env:MODEL_KEY"\n',
    );
    const result = runCli(setup.env, "doctor");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "canon writing: unverified (model configured but not bound by the running host)",
    );
    expect(result.stdout).not.toContain("canon writing: on");
  });

  test("doctor does not treat KIZUKI_MODEL_REF as a configured write path", () => {
    const setup = supervisedVault();
    const result = runCli(
      {
        ...setup.env,
        KIZUKI_MODEL_REF: "kizuki.llm.openai-compatible:synthetic@local",
      },
      "doctor",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("canon writing: off");
    expect(result.stdout).not.toContain("canon writing: on");
  });

  test("doctor stamps stay redacted and do not echo captured text", () => {
    const setup = supervisedVault();
    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes, ...fixtureConsent(setup.root),
    );
    expect(imported.exitCode).toBe(0);
    const result = runCli(setup.env, "doctor");
    expect(result.stdout).toContain("writers loop=");
    expect(result.stdout).toContain("origin machine=");
    expect(result.stdout).not.toContain("river-stone kernel");
    expect(result.stdout).not.toContain("moth-lantern patch");
    expect(result.stderr).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  test("serve --once writes a doctor-valid brief and does not fail doctor for that file", () => {
    const setup = supervisedVault();
    const once = runCli(setup.env, "serve", "--once", "--no-http");
    expect(once.exitCode).toBe(0);

    const names = readdirSync(join(setup.vault, "dashboards"));
    const briefName = names.find(
      (name) => name.startsWith("brief-") && name.endsWith(".md"),
    );
    expect(briefName).toBeDefined();
    const brief = readFileSync(join(setup.vault, "dashboards", briefName ?? ""), "utf8");
    expect(brief.startsWith("---\n")).toBe(true);

    const doctor = runCli(setup.env, "doctor", "--json");
    expect(doctor.exitCode).toBe(0);
    const report = (
      JSON.parse(doctor.stdout) as {
        data: {
          ok: boolean;
          problems: { page: string; error: string }[];
          serve: { ok: boolean };
        };
      }
    ).data;
    expect(report.ok).toBe(true);
    expect(report.serve.ok).toBe(true);
    expect(
      report.problems.filter((problem) => problem.page.startsWith("dashboards/brief-")),
    ).toEqual([]);

    runCli({ ...setup.env, KIZUKI_SUPERVISOR: "systemd" }, "serve", "--install");
    const masked = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        TEST_SUPERVISOR_STATE: "masked",
      },
      "doctor",
      "--json",
    );
    expect(masked.exitCode).toBe(1);
    expect(masked.stdout).toContain("masked");
    const maskedReport = (
      JSON.parse(masked.stdout) as {
        data: { problems: { page: string; error: string }[] };
      }
    ).data;
    expect(
      maskedReport.problems.filter((problem) =>
        problem.page.startsWith("dashboards/brief-"),
      ),
    ).toEqual([]);
  });

  test("init without a supervisor prints the exact serve command", () => {
    const env = isolatedEnv({ KIZUKI_SUPERVISOR: "none" });
    const root = env.HOME ?? "";
    const vault = `${root}/vault`;
    const result = runCli(env, "init", vault);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("supervisor: none (loop runs only while you run it)");
    expect(result.stdout).toContain(`run: kizuki serve --vault ${vault}`);
  });
});
