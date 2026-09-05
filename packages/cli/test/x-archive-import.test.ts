import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeXArchiveFixture } from "@kizuki/connectors/testkit";
import { getCheckpoint, listConnections } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

test("generic CLI enrolls, ingests, and resumes an X posts archive after restart", async () => {
  const setup = h.tempVault();
  const archive = h.tempDir("kizuki-x-cli-");
  await writeXArchiveFixture(archive);

  const catalog = h.runCli(setup.env, "connect", "--json");
  expect(catalog.exitCode).toBe(0);
  const listed = JSON.parse(catalog.stdout).data.sources as Array<{ id: string; available: boolean }>;
  expect(listed).toContainEqual(expect.objectContaining({ id: "kizuki.import-x-archive", available: true }));

  const connected = h.runCli(setup.env, "connect", "import-x-archive", "--source", archive);
  expect(connected.exitCode, connected.stderr).toBe(0);
  expect(connected.stdout).toContain("connected kizuki.import-x-archive");
  expect(connected.stdout).toContain("health=ok");
  const sourceKey = connected.stdout.match(/source=([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
  expect(sourceKey).toBeDefined();

  const granted = h.runCli(setup.env, "connect", "grant", "--source", sourceKey ?? "", ...fixtureConsent(setup.root, "fixture-x-grant"));
  expect(granted.exitCode, granted.stderr).toBe(0);

  const ingested = h.runCli(setup.env, "backfill", "import-x-archive", "--source", sourceKey ?? "");
  expect(ingested.exitCode, ingested.stderr).toBe(0);
  expect(ingested.stdout).toContain("events_stored=2");

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    expect(listConnections(db)).toHaveLength(1);
    expect(getCheckpoint(db, "kizuki.import-x-archive", sourceKey ?? "")?.cursor).not.toBeNull();
  } finally {
    db.close();
  }

  const resumed = h.runCli(setup.env, "backfill", "import-x-archive", "--source", archive);
  expect(resumed.exitCode, resumed.stderr).toBe(0);
  expect(resumed.stdout).toContain("events_stored=0");
  expect(resumed.stdout).toContain("duplicates=0");
});

test("generic CLI refuses malformed X posts before persisting enrollment", async () => {
  const setup = h.tempVault();
  const archive = h.tempDir("kizuki-x-cli-invalid-");
  await writeXArchiveFixture(archive);
  writeFileSync(
    join(archive, "data", "tweets.js"),
    'window.YTD.tweets.part0 = [{"tweet":{"id_str":"1742012345678901234","created_at":"Tue Feb 30 03:04:05 +0000 2024","full_text":"synthetic invalid date","entities":{"urls":[],"user_mentions":[]}}}];',
  );

  const result = h.runCli(setup.env, "connect", "import-x-archive", "--source", archive);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("post created_at is missing or invalid");
  expect(result.stderr).not.toContain("synthetic invalid date");
  expect(result.stderr).not.toContain("Feb 30");
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    expect(listConnections(db)).toEqual([]);
  } finally {
    db.close();
  }
});
