import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, renameSync } from "node:fs";
import { Database, constants } from "bun:sqlite";
import { join } from "node:path";
import { hardenLedgerFile } from "../../src/vault/init";
import { openLedgerRead } from "../../src/ledger/read-context";
import { gate, gateAsync } from "../../src/serving/gate";
import { listAudit, revokeAgent } from "../../src/agents";
import { serveFixture, type Fixture } from "./helpers";

let fixture: Fixture | undefined;
const bindings: ReturnType<typeof openLedgerRead>[] = [];
afterEach(() => { for (const binding of bindings.splice(0)) binding.close(); fixture?.dispose(); fixture = undefined; });
async function setup(audit = true) {
  fixture = await serveFixture();
  hardenLedgerFile(join(fixture.vaultPath, ".kizuki/kizuki.db"));
  const read = openLedgerRead(fixture.vaultPath, { audit }); bindings.push(read);
  return { fixture, read, ctx: { ...fixture.owner(), db: read.db } };
}
const empty = () => ({ canon: [], quoted: [], withheld: [] });

test("audited owner callback is query-only while its exact ledger receives one audit row", async () => {
  const { fixture: f, read, ctx } = await setup();
  const before = listAudit(f.db, "owner").length;
  gate(ctx, "search", {}, ({ ctx: live }) => {
    for (const sql of ["CREATE TABLE forbidden(x)", "INSERT INTO schema_version VALUES(99)", "UPDATE schema_version SET version=99", "DELETE FROM events"]) {
      expect(() => live.db.exec(sql)).toThrow();
    }
    expect(live.db.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    return empty();
  });
  expect(listAudit(f.db, "owner").length).toBe(before + 1);
  read.close();
  expect(() => gate(ctx, "search", {}, empty)).toThrow();
});

test("inspection has no implicit audit writer and reserve failure withholds the callback", async () => {
  const { ctx } = await setup(false);
  let ran = false;
  expect(() => gate(ctx, "search", {}, () => { ran = true; return empty(); })).toThrow();
  expect(ran).toBe(false);
});

test("audit reserve and final update failures cannot release contents", async () => {
  const { fixture: f, ctx } = await setup();
  f.db.exec("CREATE TRIGGER deny_audit_insert BEFORE INSERT ON agent_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END");
  let ran = false;
  expect(() => gate(ctx, "search", {}, () => { ran = true; return empty(); })).toThrow();
  expect(ran).toBe(false);
  f.db.exec("DROP TRIGGER deny_audit_insert");
  f.db.exec("CREATE TRIGGER deny_audit_update BEFORE UPDATE ON agent_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END");
  expect(() => gate(ctx, "search", {}, () => ({ ...empty(), data: "synthetic private result" }))).toThrow();
  expect(listAudit(f.db, "owner").at(0)?.served).toEqual([]);
});

test("post-await authority reads observe revocation without a pinned async transaction", async () => {
  const { fixture: f, read } = await setup();
  const ctx = { ...f.agent("reader-private"), db: read.db };
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const pending = gateAsync(ctx, "search", {}, async ({ ctx: live }) => {
    expect(live.db.inTransaction).toBe(false);
    await held; return { ...empty(), data: "synthetic private result" };
  });
  revokeAgent(f.db, "reader-private"); finish();
  await expect(pending).rejects.toThrow("unknown agent");
  expect(listAudit(f.db, "reader-private", { kind: "access" })[0]?.denied[0]?.reason).toBe("unknown_agent");
});

test("ledger replacement during async work refuses final audit and content release", async () => {
  const { fixture: f, ctx } = await setup();
  const path = join(f.vaultPath, ".kizuki/kizuki.db");
  await expect(gateAsync(ctx, "search", {}, async () => {
    renameSync(path, `${path}.held`);
    return { ...empty(), data: "synthetic private result" };
  })).rejects.toThrow("custody_unavailable");
  renameSync(`${path}.held`, path);
});

test("a missing reservation after async work fails closed", async () => {
  const { fixture: f, ctx } = await setup();
  await expect(gateAsync(ctx, "search", {}, async () => {
    f.db.exec("DELETE FROM agent_audit WHERE agent_id='owner'");
    return { ...empty(), data: "synthetic private result" };
  })).rejects.toThrow("reservation is missing");
});


test("a silently ignored audit update cannot release content", async () => {
  const { fixture: f, ctx } = await setup();
  f.db.exec("CREATE TRIGGER ignore_audit_update BEFORE UPDATE ON agent_audit BEGIN SELECT RAISE(IGNORE); END");
  expect(() => gate(ctx, "search", {}, () => ({ ...empty(), data: "synthetic private result" }))).toThrow("update was not recorded");
});

test("separate audited read handles share the same rate reservation ledger", async () => {
  const { fixture: f, read } = await setup();
  const second = openLedgerRead(f.vaultPath, { audit: true }); bindings.push(second);
  const principal = f.agent("slow");
  gate({ ...principal, db: read.db }, "search", {}, empty);
  gate({ ...principal, db: second.db }, "search", {}, empty);
  let ran = false;
  expect(() => gate({ ...principal, db: read.db }, "search", {}, () => { ran = true; return empty(); })).toThrow("rate limited");
  expect(ran).toBe(false);
  expect(listAudit(f.db, "slow", { kind: "access" })).toHaveLength(3);
});

test("an unrelated active writer does not block pure inspection or hide committed WAL data", async () => {
  const { fixture: f } = await setup(false);
  const expected = f.db.query("SELECT count(*) n FROM events").get();
  f.db.exec("BEGIN IMMEDIATE");
  try {
    const read = openLedgerRead(f.vaultPath); bindings.push(read);
    expect(read.db.query("SELECT count(*) n FROM events").get()).toEqual(expected);
    expect(read.db.inTransaction).toBe(false);
  } finally { f.db.exec("ROLLBACK"); }
});

test("metadata tampering during awaited work refuses release without permission repair", async () => {
  const { fixture: f, ctx } = await setup();
  const path = join(f.vaultPath, ".kizuki/kizuki.db");
  try {
    await expect(gateAsync(ctx, "search", {}, async () => {
      chmodSync(path, 0o644); return { ...empty(), data: "synthetic private result" };
    })).rejects.toThrow("custody_unavailable");
  } finally { chmodSync(path, 0o600); }
});

for (const last of ["reader", "audit"] as const) test(`the last ${last} handle closes its statements and journals without losing private audit data`, async () => {
  const { fixture: f, read, ctx } = await setup();
  const path = join(f.vaultPath, ".kizuki/kizuki.db");
  const held = Array.from({ length: 30 }, (_, i) => read.db.query(`SELECT ${i} AS held`));
  expect(read.db.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
  expect(() => read.db.exec("DELETE FROM events")).toThrow();
  if (process.platform === "darwin") {
    const policy = new Int32Array([-1]);
    expect(read.db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, policy)).toBe(0);
    expect(policy[0]).toBe(0);
  }
  const before = listAudit(f.db, "owner").length;
  gate(ctx, "search", {}, empty);
  if (last === "audit") read.db.close(true);
  f.db.close(true);
  expect(existsSync(path + "-wal")).toBe(true);
  read.close();
  for (const statement of held) expect(() => statement.get()).toThrow();
  expect(existsSync(path + "-wal")).toBe(false);
  expect(existsSync(path + "-shm")).toBe(false);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const verified = new Database(path, { readonly: true });
  try { expect(listAudit(verified, "owner").length).toBe(before + 1); }
  finally { verified.close(true); }
  expect(() => read.close()).not.toThrow();
});
