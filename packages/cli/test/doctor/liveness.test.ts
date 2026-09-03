import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "../helpers";

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("doctor liveness", () => {
  test("a masked or absent unit for an enabled vault is a failure", () => {
    const setup = tempVault();
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
        KIZUKI_SUPERVISOR_FIXTURE: "masked",
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
        KIZUKI_SUPERVISOR_FIXTURE: "absent",
      },
      "doctor",
      "--json",
    );
    expect(absent.exitCode).toBe(1);
    expect(absent.stdout).toContain("absent");
  });

  test("a deliberately disabled service is reported without failing", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "doctor", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opted-out");
  });

  test("a rail with five empty runs in a row is reported down", () => {
    const setup = tempVault();
    for (let index = 0; index < 5; index += 1) {
      const ran = runCli(setup.env, "serve", "run", "sync", "--json");
      expect(ran.exitCode).toBe(0);
    }
    const doctor = runCli(
      {
        ...setup.env,
        KIZUKI_SUPERVISOR: "systemd",
        KIZUKI_SUPERVISOR_FIXTURE: "active",
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
        KIZUKI_SUPERVISOR_FIXTURE: "active",
      },
      "doctor",
    );
    expect(live.exitCode).toBe(1);
    expect(live.stdout).toContain("empty streak");
  });

  test("doctor reports canon writing off with no model configured", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "doctor");
    expect(result.stdout).toContain(
      "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)",
    );
    expect(result.exitCode).toBe(0);
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
