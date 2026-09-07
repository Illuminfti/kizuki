import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";
import { assertBoundVaultId, openLedgerRead } from "@kizuki/core/internal";

const h = createHelpers(); afterEach(h.cleanup);
const hash = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
function files(vault: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(relative: string) {
    for (const entry of readdirSync(join(vault, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (/^\.kizuki\/kizuki\.db(?:-wal|-shm|-journal)?$/.test(path)) continue;
      result[path] = entry.isDirectory() ? "directory" : hash(join(vault, path));
      if (entry.isDirectory()) walk(path);
    }
  }
  walk(""); return result;
}
function observe(vault: string) {
  const copy = h.tempDir("read-observer-");
  const tuple = ["kizuki.db", "kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"];
  const original = Object.fromEntries(tuple.filter(name => existsSync(join(vault, ".kizuki", name))).map(name => [name, hash(join(vault, ".kizuki", name))]));
  for (const name of Object.keys(original)) copyFileSync(join(vault, ".kizuki", name), join(copy, name));
  const db = new Database(join(copy, "kizuki.db"), { readwrite: true, create: false });
  try {
    db.exec("PRAGMA query_only=ON");
    const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const audit = db.query<{ n: number }, []>("SELECT count(*) n FROM agent_audit WHERE agent_id='owner'").get()!.n;
    for (const [name, digest] of Object.entries(original)) expect(hash(join(vault, ".kizuki", name))).toBe(digest);
    return { schema, audit };
  } finally { db.close(); }
}
for (const args of [["query", "synthetic", "--json"], ["context", "--json"], ["doctor", "--json"], ["audit", "--json"], ["connect", "status", "--json"]]) {
  test(`public ${args.join(" ")} does not initialize or repair while preserving required owner audit`, () => {
    const f = h.tempVault(), before = observe(f.vault), tree = files(f.vault);
    expect(before.schema.some(row => (row as { name: string }).name === "search_docs")).toBe(true);
    const result = h.runCli(f.env, ...args);
    expect(result.exitCode).toBe(0);
    const after = observe(f.vault);
    expect(after.schema).toEqual(before.schema);
    expect(after.audit - before.audit).toBe(args[0] === "query" || args[0] === "context" ? 1 : 0);
    expect(files(f.vault)).toEqual(tree);
  });
}

test("a clean public restore is immediately readable without read-time initialization", () => {
  const f = h.tempVault(), backup = join(f.root, "backup"), restored = join(f.root, "restored");
  expect(h.runCli(f.env, "export", "--out", backup).exitCode).toBe(0);
  const restore = h.runCli(f.env, "restore", "--from", backup, "--into", restored);
  expect(restore.exitCode).toBe(0);
  const before = observe(restored), tree = files(restored);
  for (const args of [["query", "synthetic", "--json"], ["context", "--json"], ["doctor", "--json"]]) {
    const result = h.runCli(f.env, "--vault", restored, ...args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).schema).toBe(`kizuki.cli.${args[0]}/v1`);
    expect(JSON.parse(result.stdout).status).not.toBe("error");
  }
  const after = observe(restored);
  expect(after.schema).toEqual(before.schema);
  expect(after.audit).toBe(before.audit + 2);
  expect(files(restored)).toEqual(tree);
});

test("read-only contexts refuse schema repair and never remint a foreign machine binding", () => {
  const f = h.tempVault(), machine = join(f.vault, ".kizuki/vault-machine"), id = hash(join(f.vault, ".kizuki/vault-id"));
  const machineKnown = existsSync(machine);
  writeFileSync(machine, "synthetic-other-machine\n");
  expect(() => assertBoundVaultId(f.vault, "synthetic-current-machine")).toThrow("explicit initialization");
  const before = files(f.vault), result = h.runCli(f.env, "connect", "status", "--json");
  // A platform without a machine identifier cannot infer that a binding is foreign.
  expect(result.exitCode).toBe(machineKnown ? 1 : 0);
  if (machineKnown) expect(result.stdout).toBe("");
  expect(files(f.vault)).toEqual(before); expect(hash(join(f.vault, ".kizuki/vault-id"))).toBe(id);
});

test("missing authoritative schema is typed migration-required without repair", () => {
  const f = h.tempVault(), path = join(f.vault, ".kizuki/kizuki.db");
  const writer = new Database(path); writer.exec("DROP TABLE agent_audit"); writer.close();
  const before = hash(path);
  expect(() => openLedgerRead(f.vault)).toThrow("migration_required");
  expect(hash(path)).toBe(before);
  const result = h.runCli(f.env, "audit", "--json");
  expect(result.exitCode).toBe(1); expect(result.stderr).toContain("migration_required"); expect(result.stdout).toBe("");
});

test("missing optional FTS stays absent and configured PG stays unopened with explicit degradation", () => {
  const f = h.tempVault(), writer = new Database(join(f.vault, ".kizuki/kizuki.db"));
  writer.exec("DROP TABLE search_docs"); writer.close();
  const before = observe(f.vault), tree = files(f.vault);
  const missing = h.runCli(f.env, "query", "synthetic", "--json");
  expect(missing.exitCode).toBe(0); expect(missing.stdout).toContain("index-degraded");
  expect(observe(f.vault).schema).toEqual(before.schema); expect(files(f.vault)).toEqual(tree);
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
  const selected = files(f.vault), result = h.runCli(f.env, "context", "--json");
  expect(result.exitCode).toBe(0); expect(result.stdout).toContain("configured-engine-unavailable");
  expect(files(f.vault)).toEqual(selected);
});

test("doctor preserves unresolved connection/model journals and reports degradation", () => {
  const f = h.tempVault(), control = join(f.vault, ".kizuki");
  mkdirSync(join(control, "connections"), { mode: 0o700, recursive: true });
  writeFileSync(join(control, "connections/synthetic.journal"), "synthetic incomplete state", { mode: 0o600 });
  mkdirSync(join(control, "app-model"), { mode: 0o700 });
  writeFileSync(join(control, "app-model/transaction.json"), "synthetic interrupted transaction", { mode: 0o600 });
  const before = files(f.vault), result = h.runCli(f.env, "doctor", "--json");
  expect(result.exitCode).toBe(1); expect(result.stdout).toContain("connection state journals unresolved 1");
  expect(result.stdout).toContain("model configuration inspection unavailable");
  expect(result.stdout).not.toContain("synthetic incomplete state"); expect(result.stdout).not.toContain("synthetic interrupted transaction");
  expect(files(f.vault)).toEqual(before);
});


test("reads reject unsafe ledger metadata without chmod repair", () => {
  const f = h.tempVault(), path = join(f.vault, ".kizuki/kizuki.db");
  chmodSync(path, 0o644);
  const result = h.runCli(f.env, "connect", "status", "--json");
  expect(result.exitCode).toBe(1); expect(result.stdout).toBe("");
  expect(statSync(path).mode & 0o777).toBe(0o644);
});


test("app inspection routes preserve storage and query adds only its owner audit", async () => {
  const f = h.tempVault(), before = observe(f.vault), tree = files(f.vault);
  const io: CliIo = { env: f.env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out() {}, err() {}, prompt: async () => "" };
  const host = createAppHost(io);
  try {
    for (const route of ["status", "agents", "sources", "activity", "model_status"]) {
      const response = await host.handle(new Request(`http://127.0.0.1/app/v1/${route}`, { method: "POST", body: "{}" }));
      expect(response.status).toBe(200); expect((await response.json() as { ok: boolean }).ok).toBe(true);
    }
    expect(observe(f.vault)).toEqual(before); expect(files(f.vault)).toEqual(tree);
    const query = await host.handle(new Request("http://127.0.0.1/app/v1/query", { method: "POST", body: JSON.stringify({ text: "synthetic" }) }));
    expect(query.status).toBe(200);
    const after = observe(f.vault); expect(after.schema).toEqual(before.schema); expect(after.audit).toBe(before.audit + 1);
    expect(files(f.vault)).toEqual(tree);
  } finally { await host.close(); }
});


test("inspection refuses a rollback journal before SQLite can recover it", () => {
  const f = h.tempVault(), journal = join(f.vault, ".kizuki/kizuki.db-journal");
  writeFileSync(journal, "synthetic interrupted rollback", { mode: 0o600 });
  const before = hash(journal), dbBefore = hash(join(f.vault, ".kizuki/kizuki.db"));
  const result = h.runCli(f.env, "audit", "--json");
  expect(result.exitCode).toBe(1); expect(result.stdout).toBe("");
  expect(hash(journal)).toBe(before); expect(hash(join(f.vault, ".kizuki/kizuki.db"))).toBe(dbBefore);
});
