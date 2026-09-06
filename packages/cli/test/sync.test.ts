import { fixtureConsent } from "./helpers";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { applyCanonWrite, createBudgetTracker, listClaims, listConnections, resolveTarget, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault, writeNotes } = createHelpers();
afterEach(cleanup);

test.each(["connector", "service"] as const)("%s sync supplies the opened vault for source retractions", mode => {
  const setup = tempVault();
  expect(runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes).exitCode).toBe(0);
  const path = join(setup.vault, ".kizuki/kizuki.db");
  const enrollment = openLedger(path);
  try {
    // This fixture proves ingestion composition; policy-file custody has its own
    // public CLI tests and must still refuse UID-mapped untrusted ancestors.
    const source = listConnections(enrollment)[0]!;
    setSourceGrant(enrollment, { source_key: source.source_key, expected_revision: 0,
      operation_id: "synthetic-tombstone-context", policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
      } });
  } finally { enrollment.close(); }
  expect(runCli(setup.env, "import", "markdown-folder", "--source", setup.notes).exitCode).toBe(0);
  const db = openLedger(path);
  let pagePath: string;
  try {
    const claim = listClaims(db).find(item => item.kind === "claim" && item.body.includes("ada met grace"))!;
    const io = { db, vault_path: setup.vault };
    pagePath = applyCanonWrite(io, claim, resolveTarget(io, claim), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }),
    }).page_path;
  } finally { db.close(); }
  unlinkSync(join(setup.notes, "ada.md"));
  const synced = mode === "connector" ? runCli(setup.env, "sync", "markdown-folder", "--source", setup.notes) :
    runCli(setup.env, "sync", "--once");
  expect(synced.exitCode).toBe(0);
  const reopened = openLedger(path);
  try {
    const deletion = listClaims(reopened).find(item => item.kind === "deletion")!;
    expect(deletion.target).toBe(pagePath!.replace(/\.md$/, ""));
    expect(deletion.frontmatter["x-page-receipt"]).toBeString();
  } finally { reopened.close(); }
});

describe("sync selectors", () => {
  test("--source without a connector is a usage error", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "sync", "--source", setup.notes);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--source requires an explicit connector");
  });

  test("a named connector with no connections fails closed", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "sync", "markdown-folder");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no_connections");
  });

  test("one connection failure does not skip later connections", () => {
    const setup = tempVault();
    const extra = join(setup.root, "more-notes");
    writeNotes(extra);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes)
        .exitCode,
    ).toBe(0);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", extra).exitCode,
    ).toBe(0);

    const status = JSON.parse(runCli(setup.env, "connect", "status", "--json").stdout);
    for (const [index, source] of status.data.connections.entries()) {
      expect(runCli(setup.env, "connect", "grant", "--source", source.source_key, ...fixtureConsent(setup.root, `sync-fixture-${index}`)).exitCode).toBe(0);
    }
    const synced = runCli(setup.env, "sync");
    expect(synced.exitCode).toBe(0);
    expect(synced.stdout).toContain("kizuki.markdown-folder");
    expect((synced.stdout.match(/events_stored=/g) ?? []).length).toBe(2);
  });
});

for (const args of [["sync", "--once"], ["serve", "run", "sync"]]) test(`${args.join(" ")} initializes the journal on an existing current-schema vault`, () => {
  const setup = tempVault();
  const path = join(setup.vault, ".kizuki/kizuki.db");
  const old = new Database(path);
  old.exec("DROP TABLE extract_batches"); old.close();
  const result = runCli(setup.env, ...args);
  expect(result.exitCode).toBe(0);
  const reopened = new Database(path, { readonly: true });
  expect(reopened.query("SELECT name FROM sqlite_master WHERE name='extract_batches'").all()).toHaveLength(1);
  reopened.close();
});
