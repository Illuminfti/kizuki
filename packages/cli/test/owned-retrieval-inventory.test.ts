import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFts5RetrievalPort, FTS5_RETRIEVAL_ID, openLedger, setSourceGrant, tryAdvisoryFileLock } from "@kizuki/core";
import type { PortContext } from "@kizuki/core";
import { openEmbeddedRetrievalPort, EMBEDDED_RETRIEVAL_ID } from "@kizuki/retrieval-pg";
import { createOwnedRetrievalInventory } from "../src/owned-retrieval-inventory";
import { createHelpers } from "./helpers";
import { SYNTHETIC_DOCS } from "../../core/test/contracts/fixtures";
const h = createHelpers(); afterEach(h.cleanup);
function ctx(vault: string, id: string): PortContext { return { vault_path: vault, data_dir: join(vault, ".kizuki/retrieval", id), config: {}, clock: () => new Date().toISOString(), secrets: async () => "", logger: () => {} }; }

test("inventory covers historical roots independently of config and closes both discarded ports", async () => {
  const f = h.tempVault(), pg = await openEmbeddedRetrievalPort(ctx(f.vault, EMBEDDED_RETRIEVAL_ID)), fts = createFts5RetrievalPort(ctx(f.vault, FTS5_RETRIEVAL_ID));
  await pg.upsert(SYNTHETIC_DOCS); await fts.upsert(SYNTHETIC_DOCS); await fts.close();
  // Current configured port is reused. Historical FTS is opened and owned by inventory.
  const inventory = createOwnedRetrievalInventory(f.vault, pg);
  try {
    const listing = await inventory.stores();
    expect(listing.stores.map(s => s.id).sort()).toEqual([`local:${EMBEDDED_RETRIEVAL_ID}`, `local:${FTS5_RETRIEVAL_ID}`].sort());
    expect(listing.absent_store_ids).toEqual([]);
    expect(listing.stores.find(s => s.id.endsWith(EMBEDDED_RETRIEVAL_ID))!.port).toBe(pg);
    for (const store of listing.stores) {
      await store.port!.rebuildFromDocuments!([]);
      expect(await store.maintain!()).toEqual({ owned_file_maintenance: "complete" });
      await expect(store.port!.upsert(SYNTHETIC_DOCS)).rejects.toThrow("closed");
    }
    expect(existsSync(join(ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir, "store"))).toBe(false);
    expect(existsSync(join(ctx(f.vault, EMBEDDED_RETRIEVAL_ID).data_dir, "store"))).toBe(false);
  } finally { await inventory.close(); await pg.close(); }
}, 30_000);

test("inventory proves only known absent roots and refuses unknown or symlink roots", async () => {
  const f = { vault: h.tempDir() }; let inventory = createOwnedRetrievalInventory(f.vault);
  expect((await inventory.stores()).absent_store_ids).toEqual([`local:${FTS5_RETRIEVAL_ID}`, `local:${EMBEDDED_RETRIEVAL_ID}`]); await inventory.close();
  const root = join(f.vault, ".kizuki/retrieval"); mkdirSync(root, { recursive: true });
  const privateDir = h.tempDir(); writeFileSync(join(privateDir, "private"), "SYNTHETIC_DO_NOT_ERASE");
  symlinkSync(privateDir, join(root, FTS5_RETRIEVAL_ID)); inventory = createOwnedRetrievalInventory(f.vault);
  await expect(inventory.stores()).rejects.toThrow("inventory_unavailable"); await inventory.close();
  expect(readFileSync(join(privateDir, "private"), "utf8")).toBe("SYNTHETIC_DO_NOT_ERASE");
  const other = h.tempVault(); mkdirSync(join(other.vault, ".kizuki/retrieval/unknown"), { recursive: true });
  inventory = createOwnedRetrievalInventory(other.vault); await expect(inventory.stores()).rejects.toThrow("inventory_unavailable"); await inventory.close();
});

test("busy roots stay pending; corrupted generation can be erased without SQL startup", async () => {
  const f = h.tempVault(), context = ctx(f.vault, FTS5_RETRIEVAL_ID), port = createFts5RetrievalPort(context);
  let inventory = createOwnedRetrievalInventory(f.vault);
  let listing = await inventory.stores();
  expect(listing.stores[0]!.port).toBeUndefined();
  expect(await listing.stores[0]!.maintain!()).toEqual({ owned_file_maintenance: "pending" });
  await inventory.close(); await port.close();
  writeFileSync(join(context.data_dir, "store/retrieval.db"), "corrupt-synthetic-content");
  inventory = createOwnedRetrievalInventory(f.vault); listing = await inventory.stores();
  expect(listing.stores[0]!.port).toBeUndefined();
  expect(await listing.stores[0]!.maintain!()).toEqual({ owned_file_maintenance: "complete" });
  await inventory.close(); expect(existsSync(join(context.data_dir, "store"))).toBe(false);
});

test("native CLI denial and restart resume erase historical owned stores with explicit synthetic core consent", async () => {
  const f = h.tempVault();
  const enrollment = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(enrollment.exitCode).toBe(0);
  const source = enrollment.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  // Explicit fixture grant uses the public core API. Policy-file custody is a separate Linux-host gate.
  const db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-grant", policy: { purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } }); db.close();
  expect(h.runCli(f.env, "backfill", "markdown-folder").exitCode).toBe(0);
  const pg = await openEmbeddedRetrievalPort(ctx(f.vault, EMBEDDED_RETRIEVAL_ID));
  const fts = createFts5RetrievalPort(ctx(f.vault, FTS5_RETRIEVAL_ID));
  await pg.upsert(SYNTHETIC_DOCS); await fts.upsert(SYNTHETIC_DOCS); await pg.close(); await fts.close();
  const invoke = (action: string, ...args: string[]) => h.runCli(f.env, "connect", action, "--source", source, "--operation-id", "fixture-revoke", ...args, "--json");
  expect(invoke("revoke", "--expected-revision", "1").exitCode).toBe(0);
  expect(h.runCli(f.env, "backfill", "markdown-folder").exitCode).toBe(1);
  const resumed = invoke("resume-revocation");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  const output = JSON.parse(resumed.stdout).data;
  expect(output.purge).toBe("complete");
  expect(output.grant.owned_retrieval.map((s: { status: string }) => s.status)).toEqual(["maintained", "maintained"]);
  expect(existsSync(join(ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir, "store"))).toBe(false);
  expect(existsSync(join(ctx(f.vault, EMBEDDED_RETRIEVAL_ID).data_dir, "store"))).toBe(false);
  expect(invoke("resume-revocation").exitCode).toBe(0);
}, 30_000);

test("foreign current ports and symlinked store children cannot redirect maintenance", async () => {
  const first = h.tempVault(), second = h.tempVault();
  const foreign = createFts5RetrievalPort(ctx(first.vault, FTS5_RETRIEVAL_ID));
  const inventory = createOwnedRetrievalInventory(second.vault, foreign);
  try { await expect(inventory.stores()).rejects.toThrow("inventory_unavailable"); }
  finally { await inventory.close(); await foreign.close(); }
  const f = h.tempVault(), data = ctx(f.vault, EMBEDDED_RETRIEVAL_ID).data_dir;
  mkdirSync(data, { recursive: true });
  const outside = h.tempDir(); writeFileSync(join(outside, "keep"), "SYNTHETIC_OUTSIDE");
  symlinkSync(outside, join(data, "store"));
  const unsafe = createOwnedRetrievalInventory(f.vault);
  try {
    const item = (await unsafe.stores()).stores.find(s => s.id === `local:${EMBEDDED_RETRIEVAL_ID}`)!;
    expect(item.port).toBeUndefined(); expect(item.maintain).toBeUndefined();
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("SYNTHETIC_OUTSIDE");
  } finally { await unsafe.close(); }
});

test("native CLI keeps busy FTS pending then recovers its corrupted store after restart", async () => {
  const f = h.tempVault();
  const enrolled = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  const source = enrolled.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "busy-fixture-grant", policy: { purposes: ["capture"], allowed_fields: ["text"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } }); db.close();
  const context = ctx(f.vault, FTS5_RETRIEVAL_ID), held = createFts5RetrievalPort(context);
  const run = (action: string, ...args: string[]) => h.runCli(f.env, "connect", action, "--source", source, "--operation-id", "busy-fixture-revoke", ...args, "--json");
  try {
    expect(run("revoke", "--expected-revision", "1").exitCode).toBe(0);
    const pending = run("resume-revocation");
    expect(pending.exitCode, pending.stdout + pending.stderr).toBe(1);
    expect(JSON.parse(pending.stdout).data.purge).toBe("pending");
    expect(JSON.parse(pending.stdout).data.grant.owned_retrieval).toContainEqual({ store_id: `local:${FTS5_RETRIEVAL_ID}`, status: "pending" });
  } finally { await held.close(); }
  writeFileSync(join(context.data_dir, "store/retrieval.db"), "SYNTHETIC_BROKEN_PRIVATE_GENERATION");
  const resumed = run("resume-revocation");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).data.purge).toBe("complete");
  expect(existsSync(join(context.data_dir, "store"))).toBe(false);
}, 15_000);


test("an unused initialized FTS root proves empty maintenance without creating SQL", async () => {
  const f = h.tempVault(), path = ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir;
  const inventory = createOwnedRetrievalInventory(f.vault);
  try {
    const item = (await inventory.stores()).stores.find(s => s.id === `local:${FTS5_RETRIEVAL_ID}`)!;
    expect(item.port).toBeUndefined();
    expect(await item.maintain!()).toEqual({ owned_file_maintenance: "complete" });
    expect(existsSync(join(path, "store"))).toBe(false);
    expect(existsSync(join(path, "writer.lock"))).toBe(false);
  } finally { await inventory.close(); }
});

test("native resume completes with the ordinary unused initialized FTS directory", async () => {
  const f = h.tempVault();
  const enrollment = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(enrollment.exitCode).toBe(0);
  const source = enrollment.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const db = openLedger(join(f.vault, ".kizuki/kizuki.db"));
  setSourceGrant(db, {source_key:source,expected_revision:0,operation_id:"empty-fixture-grant",policy:{purposes:["capture"],allowed_fields:["text","subjects","attachments","metadata"],retention:"persistent_owned_until_revoked",egress:"local_only",sensitivity_floor:"private"}}); db.close();
  expect(h.runCli(f.env, "backfill", "markdown-folder").exitCode).toBe(0);
  const run = (action: string, ...args: string[]) => h.runCli(f.env, "connect", action, "--source", source, "--operation-id", "empty-fixture-revoke", ...args, "--json");
  expect(run("revoke", "--expected-revision", "1").exitCode).toBe(0);
  const resumed = run("resume-revocation");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).data.purge).toBe("complete");
  expect(existsSync(join(ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir, "store"))).toBe(false);
  expect(run("resume-revocation").exitCode).toBe(0);
});


test("empty-root maintenance refuses new contents and a held existing native lock", async () => {
  const f = h.tempVault(), path = ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir;
  let inventory = createOwnedRetrievalInventory(f.vault);
  try {
    const item = (await inventory.stores()).stores.find(s => s.id === `local:${FTS5_RETRIEVAL_ID}`)!;
    writeFileSync(join(path, "unknown"), "SYNTHETIC_KEEP");
    expect(await item.maintain!()).toEqual({owned_file_maintenance:"pending"});
    expect(readFileSync(join(path, "unknown"), "utf8")).toBe("SYNTHETIC_KEEP");
  } finally { await inventory.close(); }
  const g = h.tempVault(), data = ctx(g.vault, FTS5_RETRIEVAL_ID).data_dir;
  const lock = tryAdvisoryFileLock(join(data, "writer.lock"))!;
  inventory = createOwnedRetrievalInventory(g.vault);
  try {
    const item = (await inventory.stores()).stores.find(s => s.id === `local:${FTS5_RETRIEVAL_ID}`)!;
    expect(item.port).toBeUndefined();
    expect(await item.maintain!()).toEqual({owned_file_maintenance:"pending"});
    expect(existsSync(join(data, "store"))).toBe(false);
  } finally { await inventory.close(); lock.release(); }
});


test("an empty root replaced after inventory cannot be credited as maintained", async () => {
  const f = h.tempVault(), path = ctx(f.vault, FTS5_RETRIEVAL_ID).data_dir;
  const inventory = createOwnedRetrievalInventory(f.vault);
  try {
    const item = (await inventory.stores()).stores.find(s => s.id === `local:${FTS5_RETRIEVAL_ID}`)!;
    renameSync(path, path + "-moved");
    const outside = h.tempDir();
    symlinkSync(outside, path);
    expect(await item.maintain!()).toEqual({owned_file_maintenance:"pending"});
    expect(existsSync(join(outside, "store"))).toBe(false);
  } finally { await inventory.close(); }
});
