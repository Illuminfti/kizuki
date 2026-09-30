import { rmSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { createHelpers, fixtureConsent } from "../helpers";
import { disconnect } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { join } from "node:path";

const h = createHelpers();
afterEach(h.cleanup);

test("doctor and both connect status forms disclose the same persisted coverage", () => {
  const { env, root, notes, vault } = h.tempVault();
  const connected = h.runCli(env, "connect", "markdown-folder", "--source", notes);
  expect(connected.exitCode).toBe(0);
  const source = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const never = JSON.parse(h.runCli(env, "connect", "status", "--json").stdout).data.connections[0].coverage;
  expect(never).toMatchObject({ backfill_state: "never_run", last_successful_pass_at: null, ingested: 0 });
  expect(never.blind_spots).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "never_completed_pass", next_step: expect.any(String) })]));
  expect(h.runCli(env, "connect", "grant", "--source", source, ...fixtureConsent(root)).exitCode).toBe(0);
  expect(h.runCli(env, "sync", "markdown-folder").exitCode).toBe(0);
  const coverage = JSON.parse(h.runCli(env, "connect", "status", "--json").stdout).data.connections[0].coverage;
  expect(coverage).toMatchObject({ scanned: 3, ingested: 3, pending: 0, failed: 0, backfill_complete: true, backfill_state: "complete", first_occurred_at: expect.any(String), last_occurred_at: expect.any(String), last_successful_pass_at: expect.any(String) });
  expect(JSON.parse(h.runCli(env, "doctor", "--json").stdout).data.connections[0].coverage).toEqual(coverage);
  expect(JSON.parse(h.runCli(env, "connect", "status", "--source", source, "--json").stdout).data.coverage).toEqual(coverage);
  for (const args of [["doctor"], ["connect", "status"], ["connect", "status", "--source", source]]) {
    const output = h.runCli(env, ...args).stdout;
    expect(output).toContain("scanned=3 ingested=3");
    expect(output).toContain("backfill_complete=yes");
    expect(output).toContain("attachments");
  }
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try { disconnect(db, "kizuki.markdown-folder", source); } finally { db.close(); }
  const disabled = h.runCli(env, "doctor", "--json");
  expect(disabled.exitCode).toBe(0);
  expect(JSON.parse(disabled.stdout).data.connections[0]).toMatchObject({
    state: "disconnected", health: "disabled", coverage: { backfill_complete: true,
      blind_spots: expect.arrayContaining([expect.objectContaining({ reason: "disabled_source" })]) },
  });
}, 120_000);


test("a source with no successful pass retains its error class across CLI restarts", () => {
  const { env, notes, root } = h.tempVault();
  const connected = h.runCli(env, "connect", "markdown-folder", "--source", notes);
  const source = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  expect(h.runCli(env, "connect", "grant", "--source", source, ...fixtureConsent(root)).exitCode).toBe(0);
  rmSync(notes, { recursive: true });
  expect(h.runCli(env, "backfill", "markdown-folder").exitCode).not.toBe(0);
  const coverage = JSON.parse(h.runCli(env, "connect", "status", "--source", source, "--json").stdout).data.coverage;
  expect(coverage).toMatchObject({ backfill_complete: false, backfill_state: "failed", last_successful_pass_at: null, last_error_class: "misconfigured" });
  expect(coverage.blind_spots).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "never_completed_pass" })]));
}, 120_000);
