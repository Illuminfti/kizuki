import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorStatus } from "@kizuki/core";
import {
  custodyUnavailableMessage,
  observeInstalledService,
  serviceNotRunningLines,
  supervisorFailureLine,
} from "../src/service-custody";
import { createHelpers } from "./helpers";
import { fakeSystemd } from "./serve/supervisor-fixture";

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
  test("names the missing prerequisite and a command to run", () => {
    const message = custodyUnavailableMessage("/home/stranger/kizuki");
    expect(message).not.toBe("service_custody_unavailable");
    expect(message).toContain("service_custody_unavailable");
    expect(message).toContain("/home/stranger/kizuki");
    expect(message).toContain("owned by you or by root");
    expect(message).toContain("/tmp");
    expect(message).toMatch(/\binit\b/);
    expect(message).toMatch(/\bdoctor\b/);
  });

  test("a unit that did not stay running names the unit, the state and where to look", () => {
    const lines = serviceNotRunningLines(status({ state: "disabled", detail: "failed" }), "/home/stranger/kizuki");
    expect(lines.join("\n")).toContain("kizuki@synthetic.service");
    expect(lines.join("\n")).toContain("failed");
    expect(lines.join("\n")).toContain("journalctl --user -u kizuki@synthetic.service");
    expect(lines.join("\n")).toContain("/home/stranger/kizuki");
  });
});

describe("supervisor failure rendering", () => {
  test("replaces the coarse state with the observed one and leaves other failures alone", () => {
    expect(supervisorFailureLine("supervisor unknown", status({ state: "unknown", detail: "activating" })))
      .toContain("kizuki@synthetic.service");
    expect(supervisorFailureLine("supervisor unknown", status({ state: "unknown", detail: "activating" })))
      .toContain("activating");
    expect(supervisorFailureLine("supervisor disabled", status({ state: "disabled", detail: "failed" })))
      .toContain("failed");
    expect(supervisorFailureLine("rail loop: down", status())).toBe("rail loop: down");
  });

  test("an unqueryable supervisor still says so rather than borrowing a state", () => {
    const line = supervisorFailureLine("supervisor unknown",
      status({ state: "unknown", detail: "supervisor state could not be queried" }));
    expect(line).toContain("supervisor state could not be queried");
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
    for (const [activity, expected] of [["failed", "failed"], ["activating", "activating"]] as const) {
      const doctor = runCli({ ...env, KIZUKI_VAULT: vault, TEST_SUPERVISOR_ACTIVITY: activity },
        "doctor");
      expect(doctor.stdout).not.toContain("serve-failure supervisor unknown");
      expect(doctor.stdout).toContain(`serve-failure supervisor kizuki@${id}.service`);
      expect(doctor.stdout).toContain(expected);
    }
  }, 30_000);
});
