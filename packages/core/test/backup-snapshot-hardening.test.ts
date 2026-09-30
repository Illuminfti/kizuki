import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addAgent } from "../src/agents/identity";
import { disconnect } from "../src/ledger/connections";
import { registerConnection, revokeSourceGrant, setSourceGrant } from "../src/index";
import { openLedger } from "../src/ledger/db";
import { rebuildReceiptJournal } from "../src/canon/receipt-journal";
import { backupVault, exclusionWarnings, restoreSnapshot, verifySnapshot } from "../src/snapshot";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { putEvent, storeClaim, write } from "./canon/helpers";

setDefaultTimeout(60_000);
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

const policy = {
  purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-snapshot-hardening-"));
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, vault, db, at: (name: string) => join(root, name) };
}

async function withPage(f: ReturnType<typeof fixture>) {
  const claim = await storeClaim(f.db, putEvent(f.db));
  write({ db: f.db, vault_path: f.vault }, claim);
}

test("a snapshot of a vault with agent world state strips the wire rows and restores", async () => {
  const f = fixture();
  const { agent } = addAgent(f.db, "example-agent");
  const namespace = "a".repeat(32);
  const wire = `${"A".repeat(42)}A`;
  f.db.query("INSERT INTO world_authorization_namespaces (namespace_id, principal_id, authorization) VALUES (?, ?, '{}')").run(namespace, agent.agent_id);
  f.db.query("INSERT INTO world_wire_refs (namespace_id, wire_ref, ref_kind) VALUES (?, ?, 'principal')").run(namespace, wire);
  f.db.query("INSERT INTO world_wire_principal_targets (namespace_id, wire_ref, principal_id) VALUES (?, ?, ?)").run(namespace, wire, agent.agent_id);
  await backupVault(f.db, f.vault, f.at("snapshot"));
  const copy = new Database(join(f.at("snapshot"), "ledger.db"), { readonly: true });
  try {
    for (const table of ["world_authorization_namespaces", "world_wire_refs", "world_wire_principal_targets"])
      expect(copy.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(copy.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { copy.close(); }
  expect(readFileSync(join(f.at("snapshot"), "ledger.db")).includes(Buffer.from(agent.agent_id))).toBe(false);
  expect(restoreSnapshot(f.at("snapshot"), f.at("restored")).agents).toEqual(["example-agent"]);
});

test("a snapshot keeps no connector state or secret reference", async () => {
  const f = fixture();
  const key = ulid();
  registerConnection(f.db, "kizuki.fixture", key);
  f.db.query("UPDATE connections SET config=?, secret_refs=? WHERE source_key=?").run(
    '{"schema":"kizuki.connection-config/v1","state_ref_index":0}', `["file:connections/${key}.state"]`, key);
  await backupVault(f.db, f.vault, f.at("snapshot"));
  expect(readFileSync(join(f.at("snapshot"), "ledger.db")).includes(Buffer.from(`connections/${key}.state`))).toBe(false);
  const copy = new Database(join(f.at("snapshot"), "ledger.db"), { readonly: true });
  try { expect(copy.query("SELECT secret_refs FROM connections WHERE source_key=?").get(key)).toEqual({ secret_refs: "[]" }); }
  finally { copy.close(); }
});

test("a revoked source that is disconnected and empty does not block a snapshot", async () => {
  const f = fixture();
  const key = ulid();
  registerConnection(f.db, "kizuki.fixture", key);
  setSourceGrant(f.db, { source_key: key, expected_revision: 0, operation_id: "grant-empty", policy });
  disconnect(f.db, "kizuki.fixture", key);
  revokeSourceGrant(f.db, { source_key: key, expected_revision: 1, operation_id: "revoke-empty" });
  expect((await backupVault(f.db, f.vault, f.at("snapshot"))).complete).toBe(true);
  restoreSnapshot(f.at("snapshot"), f.at("restored"));
});

test("the manifest states what a snapshot leaves out", async () => {
  const f = fixture();
  await withPage(f);
  mkdirSync(join(f.vault, "dashboards"), { recursive: true });
  writeFileSync(join(f.vault, "dashboards", "brief-1.md"), "# Brief\n");
  writeFileSync(join(f.vault, "loose.md"), "# Loose\n");
  writeFileSync(join(f.vault, ".kizuki", "serve.toml"), "[extraction]\n");
  const manifest = await backupVault(f.db, f.vault, f.at("snapshot"));
  expect(manifest.excluded_entries.unclassified).toBeGreaterThanOrEqual(2);
  expect(manifest.excluded_entries.hidden).toBeGreaterThanOrEqual(1);
  expect(manifest.recovery_limits.join(" ")).toContain("serve.toml");
  expect(Object.keys(manifest.files).some(path => path.includes("loose.md") || path.includes("serve.toml"))).toBe(false);
  expect(verifySnapshot(f.at("snapshot")).excluded_entries).toEqual(manifest.excluded_entries);
  expect(restoreSnapshot(f.at("snapshot"), f.at("restored")).recovery_warnings.join(" ")).toContain("unclassified=");
  expect(exclusionWarnings({ hidden: 0, links_or_special: 0, backup_containers: 0, unclassified: 0 })).toEqual([]);
});

test("restore refuses altered page bytes even when the manifest is rehashed", async () => {
  const f = fixture();
  await withPage(f);
  await backupVault(f.db, f.vault, f.at("snapshot"));
  const manifestPath = join(f.at("snapshot"), "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const page = join(f.at("snapshot"), "vault", "people", "grace.md");
  const altered = Buffer.from(readFileSync(page, "utf8").replace("Grace runs partnerships", "Grace was replaced"));
  writeFileSync(page, altered);
  const sha256 = new Bun.CryptoHasher("sha256").update(altered).digest("hex");
  manifest.files["vault/people/grace.md"] = { size: altered.length, sha256 };
  const { manifest_sha256: _drop, ...unsigned } = manifest;
  manifest.manifest_sha256 = new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  expect(() => verifySnapshot(f.at("snapshot"))).not.toThrow();
  expect(() => restoreSnapshot(f.at("snapshot"), f.at("restored"))).toThrow("does not match its receipts");
});

test("the rebuilt receipt journal streams every receipt in order", async () => {
  const f = fixture();
  await withPage(f);
  const path = join(f.vault, ".kizuki", "receipts", "promotions.jsonl");
  const before = existsSyncSafe(path) ? readFileSync(path, "utf8") : null;
  const copy = join(f.root, "rebuilt");
  mkdirSync(dirname(join(copy, ".kizuki", "receipts")), { recursive: true });
  expect(rebuildReceiptJournal(f.db, copy)).toBe(1);
  if (before !== null) expect(readFileSync(join(copy, ".kizuki", "receipts", "promotions.jsonl"), "utf8")).toBe(before);
});

function existsSyncSafe(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
