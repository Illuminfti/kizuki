import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorStatus } from "@kizuki/core";
import { SERVICE_REFUSAL_EXIT } from "@kizuki/core/internal";
import {
  custodyUnavailableMessage,
  observeInstalledService,
  serviceNotRunningLines,
  serviceStartupExit,
  supervisorFailureLine,
} from "../src/service-custody";
import { INVOCATION } from "../src/runtime";
import { createHelpers } from "./helpers";
import { fakeSystemd } from "./serve/supervisor-fixture";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, isolatedEnv, runCli, tempDir } = createHelpers();
afterEach(cleanup);

function status(overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    kind: "systemd",
    state: "active",
    unit: "kizuki@synthetic.service",
    enabled: true,
    detail: "active",
    ...overrides,
  };
}

describe("installed service observation", () => {
  test("returns the first sample that is not running", async () => {
    const samples = [
      status(),
      status(),
      status({ state: "disabled", detail: "failed" }),
      status({ state: "active", detail: "active" }),
    ];
    let taken = 0;
    const waited: number[] = [];
    const observed = await observeInstalledService(() => samples[taken++] ?? status(), {
      settleMs: 1_000,
      sampleMs: 100,
      now: () => waited.reduce((total, value) => total + value, 0),
      wait: async (ms) => { waited.push(ms); },
    });
    expect(observed).toMatchObject({ state: "disabled", detail: "failed" });
    expect(taken).toBe(3);
  });

  test("returns the last sample when the unit stays running for the whole window", async () => {
    let taken = 0;
    let clock = 0;
    const observed = await observeInstalledService(() => { taken += 1; return status(); }, {
      settleMs: 500,
      sampleMs: 100,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    });
    expect(observed.state).toBe("active");
    expect(taken).toBe(6);
  });
});

describe("custody refusal copy", () => {
  const unit = "kizuki@synthetic.service";

  test("an unexplained refusal names the vault and where to look, and diagnoses nothing", () => {
    const message = custodyUnavailableMessage("/home/stranger/kizuki", unit);
    expect(message).not.toBe("service_custody_unavailable");
    expect(message).toContain("service_custody_unavailable");
    expect(message).toContain("/home/stranger/kizuki");
    expect(message).toContain(`journalctl --user -u ${unit} -n 50`);
    expect(message).toMatch(/\bdoctor\b/);
    // The ancestor-ownership prerequisite is one candidate among several, and
    // recreating the vault is never prescribed for a cause nothing observed.
    expect(message).toContain("possible causes");
    expect(message).toContain("/tmp");
    expect(message).not.toMatch(/\binit\b/);
  });

  test("an unsupported machine says so instead of blaming the vault", () => {
    const message = custodyUnavailableMessage("/home/stranger/kizuki", unit, "unsupported_platform", "linux arm64");
    expect(message).toContain("linux arm64");
    expect(message).toContain("Linux x64");
    expect(message).toContain("nothing about the vault is wrong");
    expect(message).toContain("serve --uninstall --vault /home/stranger/kizuki");
    expect(message).not.toContain("/tmp");
    expect(message).not.toContain("possible causes");
  });

  test("a launch the supervisor did not make, a root launch and a lost hold each read differently", () => {
    const outside = custodyUnavailableMessage("/home/stranger/kizuki", unit, "not_supervised");
    expect(outside).toContain("no proof that the supervisor started it");
    expect(outside).not.toContain("/tmp");
    const root = custodyUnavailableMessage("/home/stranger/kizuki", unit, "root_user");
    expect(root).toContain("refuses to run as root");
    expect(root).not.toContain("/tmp");
    const lost = custodyUnavailableMessage("/home/stranger/kizuki", unit, "custody_lost");
    expect(lost).toContain("lost its proof of custody");
    expect(lost).toContain(`journalctl --user -u ${unit} -n 50`);
    expect(lost).not.toContain("possible causes");
    expect(new Set([outside, root, lost]).size).toBe(3);
  });

  test("a vault binding the unit no longer matches names the reinstall, not the log", () => {
    const message = custodyUnavailableMessage("/home/stranger/kizuki vault", unit, "vault_mismatch");
    expect(message).toContain("service_custody_unavailable");
    expect(message).toContain(`${INVOCATION} serve --install --vault '/home/stranger/kizuki vault'`);
    expect(message).not.toContain("possible causes");
    expect(message).not.toContain("doctor");
  });

  test("a refusal with no unit to name omits the inspection line rather than invent one", () => {
    const message = custodyUnavailableMessage("/home/stranger/kizuki", null, "custody_lost");
    expect(message).not.toContain("journalctl");
    expect(message).toContain("lost its proof of custody");
  });

  test("a unit that did not stay running names the unit, the state and where to look", () => {
    const text = serviceNotRunningLines(status({ state: "disabled", detail: "failed" }), "/home/stranger/kizuki").join("\n");
    expect(text).toContain("kizuki@synthetic.service was installed but did not stay running");
    expect(text).toContain("supervisor state failed");
    expect(text).toContain("journalctl --user -u kizuki@synthetic.service");
    expect(text).toContain("/home/stranger/kizuki");
  });
});

describe("installed service startup exit status", () => {
  test("only refusals that repeat on every start exit 78; transient custody failures exit 1", () => {
    for (const reason of ["unsupported_platform", "not_supervised", "root_user", "vault_mismatch", "migration_required"] as const) {
      expect({ reason, code: serviceStartupExit(reason) }).toEqual({ reason, code: SERVICE_REFUSAL_EXIT });
    }
    for (const reason of ["custody_unproven", "custody_lost"] as const) {
      expect({ reason, code: serviceStartupExit(reason) }).toEqual({ reason, code: 1 });
    }
  });
});

describe("supervisor failure rendering", () => {
  const vault = "/home/stranger/o'neil vault", quoted = `'/home/stranger/o'\\''neil vault'`;
  test("a failed unit names the command that follows from its own exit, never only the log", () => {
    const failed = status({ state: "disabled", detail: "failed" });
    const refused = supervisorFailureLine("supervisor disabled", failed, { result: "exit-code", exit_status: 78 }, vault);
    expect(refused).toContain("state=failed");
    expect(refused).toContain(`reinstall: ${INVOCATION} serve --install --vault ${quoted}`);
    const limited = supervisorFailureLine("supervisor disabled", failed, { result: "start-limit-hit", exit_status: 1 }, vault);
    expect(limited).toContain("stopped restarting it after repeated failed starts");
    expect(limited).toContain("restart it: systemctl --user reset-failed kizuki@synthetic.service && systemctl --user start kizuki@synthetic.service");
    expect(limited).not.toContain("see: journalctl");
    const crashed = supervisorFailureLine("supervisor disabled", failed, { result: "oom-kill", exit_status: 137 }, vault);
    expect(crashed).toContain("last run ended with oom-kill (exit status 137)");
    expect(crashed).toContain("restart it: systemctl --user reset-failed kizuki@synthetic.service && systemctl --user start kizuki@synthetic.service");
    const stopped = supervisorFailureLine("supervisor disabled", status({ state: "disabled", detail: "inactive (enabled)" }), { result: "success", exit_status: 0 }, vault);
    expect(stopped).toContain("start it: systemctl --user start kizuki@synthetic.service");
    expect(new Set([refused, limited, crashed, stopped]).size).toBe(4);
  });

  test("replaces the coarse state with the observed one and leaves other failures alone", () => {
    expect(supervisorFailureLine("supervisor unknown", status({ state: "unknown", detail: "activating" })))
      .toBe("supervisor kizuki@synthetic.service state=activating enabled=yes"
        + "; see: journalctl --user -u kizuki@synthetic.service -n 50");
    expect(supervisorFailureLine("supervisor disabled", status({ state: "disabled", detail: "failed" })))
      .toContain("state=failed");
    expect(supervisorFailureLine("rail loop: down", status())).toBe("rail loop: down");
  });

  test("an unqueryable supervisor still says so rather than borrowing a state", () => {
    const line = supervisorFailureLine("supervisor unknown",
      status({ state: "unknown", detail: "supervisor state could not be queried" }));
    expect(line).toContain("state=unknown");
    expect(line).toContain("supervisor state could not be queried");
  });

  test("a host with no supervisor reports state=none, not its own description of itself", () => {
    const none = status({
      kind: "none", state: "none", unit: null, enabled: false,
      detail: "supervisor: none (loop runs only while you run it)",
    });
    const line = supervisorFailureLine("supervisor none", none);
    expect(line).toStartWith("supervisor none state=none enabled=no");
    expect(line).not.toContain("state=supervisor");
    expect(line).not.toContain("journalctl");
  });
});

describe("doctor reports the observed supervisor state", () => {
  test("a failed unit is never reported as an unknown supervisor", () => {
    const root = tempDir();
    const env = { ...fakeSystemd(root, isolatedEnv()), KIZUKI_SUPERVISOR: "systemd" };
    const vault = join(root, "vault");
    expect(runCli(env, "init", vault, "--no-default", "--no-service").exitCode).toBe(0);
    expect(runCli({ ...env, KIZUKI_VAULT: vault }, "serve", "--install").exitCode).toBe(0);
    const id = readFileSync(join(vault, ".kizuki", "vault-id"), "utf8").trim();
    for (const activity of ["failed", "activating"] as const) {
      const doctor = runCli({ ...env, KIZUKI_VAULT: vault, TEST_SUPERVISOR_ACTIVITY: activity }, "doctor");
      expect(doctor.stdout).not.toContain("serve-failure supervisor unknown");
      expect(doctor.stdout).toContain(
        `serve-failure supervisor kizuki@${id}.service state=${activity} enabled=yes`);
    }
  }, 30_000);

  test("doctor reads the unit's exit status and prints the command that restarts it", () => {
    const root = tempDir();
    const env = { ...fakeSystemd(root, isolatedEnv()), KIZUKI_SUPERVISOR: "systemd" };
    const vault = join(root, "vault");
    expect(runCli(env, "init", vault, "--no-default", "--no-service").exitCode).toBe(0);
    expect(runCli({ ...env, KIZUKI_VAULT: vault }, "serve", "--install").exitCode).toBe(0);
    const unit = `kizuki@${readFileSync(join(vault, ".kizuki", "vault-id"), "utf8").trim()}.service`;
    const failed = { ...env, KIZUKI_VAULT: vault, TEST_SUPERVISOR_ACTIVITY: "failed", TEST_SUPERVISOR_RESULT: "exit-code", TEST_SUPERVISOR_EXEC_STATUS: "78" };
    const refused = runCli(failed, "doctor");
    expect(refused.stdout).toContain(`reinstall: ${INVOCATION} serve --install --vault ${vault}`);
    expect(JSON.parse(runCli(failed, "doctor", "--json").stdout).data.serve.supervisor_exit).toEqual({ result: "exit-code", exit_status: 78 });
    const limited = runCli({ ...failed, TEST_SUPERVISOR_RESULT: "start-limit-hit", TEST_SUPERVISOR_EXEC_STATUS: "1" }, "doctor");
    expect(limited.stdout).toContain(`restart it: systemctl --user reset-failed ${unit} && systemctl --user start ${unit}`);
    // A running unit is not asked about its last exit.
    expect(JSON.parse(runCli({ ...env, KIZUKI_VAULT: vault }, "doctor", "--json").stdout).data.serve.supervisor_exit).toBeNull();
  }, 30_000);
});
