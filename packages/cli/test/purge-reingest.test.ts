import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSince } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const MARKER = "zqxreingestmarker4471";

function events(vault: string) {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try { return readSince(db, null, 50).events; } finally { db.close(); }
}

function setup() {
  const s = tempVault();
  writeFileSync(join(s.notes, "acme.md"), `Grace runs partnerships at Acme. ${MARKER}\n`);
  const imported = runCli(s.env, "import", "markdown-folder", "--source", s.notes, ...fixtureConsent(s.root));
  expect(imported.exitCode).toBe(0);
  const target = events(s.vault).find((event) => event.source_record_id === "acme.md")!;
  return { ...s, target };
}

test("purge warns with the path of a source record that still exists", () => {
  const s = setup();
  const purged = runCli(s.env, "purge", "--event", s.target.event_id, "--reason", "retire");
  expect(purged.exitCode).toBe(0);
  expect(purged.stderr).toContain(`the source record still exists at ${join(s.notes, "acme.md")}`);
  expect(purged.stderr).toContain("kizuki purge --lift-suppression");
});

test("a later sync refuses the purged record, reports it, and the owner can lift the refusal", () => {
  const s = setup();
  const purged = runCli(s.env, "purge", "--event", s.target.event_id, "--reason", "retire", "--json");
  expect(purged.exitCode).toBe(0);
  const receipt = JSON.parse(purged.stdout).data.receipts[0].receipt_id as string;
  expect(JSON.parse(purged.stdout).data.source_records_still_present).toEqual([join(s.notes, "acme.md")]);

  // The source file changes, so the connector offers the record again.
  appendFileSync(join(s.notes, "acme.md"), "One more line.\n");
  const refused = runCli(s.env, "sync", "markdown-folder", "--source", s.notes);
  expect(refused.exitCode).toBe(0);
  expect(refused.stdout).toContain("suppressed=1");
  expect(refused.stderr).toContain("purged earlier");
  expect(events(s.vault).some((event) => event.source_record_id === "acme.md")).toBe(false);

  const listed = JSON.parse(runCli(s.env, "purge", "--suppressions", "--json").stdout);
  expect(listed.data.suppressions).toMatchObject([{ connector_id: s.target.connector_id, source_record_id: "acme.md", receipt_id: receipt }]);
  expect(runCli(s.env, "purge", "--suppressions").stdout).toContain("acme.md");

  const lifted = runCli(s.env, "purge", "--lift-suppression", receipt);
  expect(lifted.exitCode).toBe(0);
  expect(lifted.stdout).toContain("lifted 1 suppression");
  expect(JSON.parse(runCli(s.env, "purge", "--suppressions", "--json").stdout).data.suppressions).toEqual([]);

  appendFileSync(join(s.notes, "acme.md"), "A third line.\n");
  const allowed = runCli(s.env, "sync", "markdown-folder", "--source", s.notes);
  expect(allowed.exitCode).toBe(0);
  expect(allowed.stdout).not.toContain("suppressed=");
  expect(events(s.vault).some((event) => event.source_record_id === "acme.md")).toBe(true);
});

test("lifting names a purge that has nothing to lift", () => {
  const s = setup();
  const result = runCli(s.env, "purge", "--lift-suppression", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no active suppression");
});

test("suppression flags refuse to combine with a purge selector", () => {
  const s = setup();
  expect(runCli(s.env, "purge", "--suppressions", "--event", s.target.event_id).exitCode).toBe(2);
  expect(runCli(s.env, "purge", "--lift-suppression", "X", "--suppressions").exitCode).toBe(2);
});
