import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeRailCursor } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor and serve status display quarantine locators while redacting restored reasons", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const handle = "a".repeat(32);
  const path = `auto/world/${handle}.md`;
  const marker = "synthetic-secret-value-1234567890";
  try {
    writeRailCursor(db, "kizuki.canon.writer", `stuck:${handle}`, JSON.stringify({
      path, attempts: 3, reason: `secret=${marker}`, last_at: new Date().toISOString(),
    }));
  } finally { db.close(); }

  const doctor = runCli(setup.env, "doctor");
  expect(doctor.exitCode).toBe(0);
  expect(doctor.stderr).toBe("");
  expect(doctor.stdout).toContain("quarantined typed pages=1");
  expect(doctor.stdout).toContain(`quarantined ${path} handle=${handle} failed_passes=3`);
  expect(doctor.stdout).not.toContain(marker);
  expect(doctor.stdout).toContain("[redacted]");

  const json = runCli(setup.env, "doctor", "--json");
  expect(json.exitCode).toBe(0);
  expect(json.stderr).toBe("");
  expect(JSON.parse(json.stdout).data.serve.quarantined.pages).toEqual([
    expect.objectContaining({ handle, path, attempts: 3, reason: "secret=[redacted]" }),
  ]);

  const status = runCli(setup.env, "serve", "status");
  expect(status.stdout).toContain("quarantined typed pages=1");
  expect(status.stdout).not.toContain(marker);
});
