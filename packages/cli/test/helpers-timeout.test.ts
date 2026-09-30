import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { CLI_CHILD_TIMEOUT_MS, createHelpers } from "./helpers";

setDefaultTimeout(30_000);

test("the default child bound fails a hung child in under two minutes", () => {
  expect(CLI_CHILD_TIMEOUT_MS).toBeGreaterThan(0);
  expect(CLI_CHILD_TIMEOUT_MS).toBeLessThan(120_000);
});

// A 1 ms bound cannot be met by any process start, so the child is always
// killed for overrunning it, standing in for a child that hangs.
const impatient = createHelpers({ childTimeoutMs: 1 });
afterEach(impatient.cleanup);

test("runCli kills a child that overruns the bound and fails with a message", () => {
  expect(() => impatient.runCli(impatient.isolatedEnv(), "version")).toThrow(
    "kizuki version did not exit within 1 ms and was killed",
  );
});

test("runCliAsync kills a child that overruns the bound and fails with a message", async () => {
  await expect(impatient.runCliAsync(impatient.isolatedEnv(), "version")).rejects.toThrow(
    "kizuki version did not exit within 1 ms and was killed",
  );
});

test("a child that finishes inside the bound is unaffected", async () => {
  const patient = createHelpers();
  try {
    const result = await patient.runCliAsync(patient.isolatedEnv(), "version");
    expect(result.exitCode).toBe(0);
  } finally {
    patient.cleanup();
  }
});
