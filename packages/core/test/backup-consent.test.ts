import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, listAgents } from "../src/agents/identity";
import { accept, exportVault, registerConnection, revokeSourceGrant, setSourceGrant } from "../src/index";
import { recoverCanonWrites } from "../src/canon/recovery";
import { openLedger } from "../src/ledger/db";
import { backupVault, restoreSnapshot, verifySnapshot } from "../src/snapshot";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";
import { putEvent, storeClaim, write } from "./canon/helpers";

setDefaultTimeout(60_000);
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

const withoutExport = {
  purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-snapshot-consent-"));
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const source = () => {
    const key = ulid();
    registerConnection(db, "kizuki.fixture", key);
    setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `grant-${key}`, policy: withoutExport });
    return key;
  };
  return { root, vault, db, source, at: (name: string) => join(root, name) };
}

test("an owner-local snapshot does not need the export purpose, and the restored vault keeps that consent", async () => {
  const f = fixture();
  const key = f.source();
  const stored = accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", text: "Synthetic evidence." }, { source: { source_key: key, expected_revision: 1 } });
  expect(stored.status).toBe("stored");
  expect(() => exportVault(f.db, f.vault, f.at("export"))).toThrow("source_export_denied");
  const manifest = await backupVault(f.db, f.vault, f.at("snapshot"));
  expect(manifest.events).toBe(1);
  restoreSnapshot(f.at("snapshot"), f.at("restored"));
  const restored = openLedger(join(f.at("restored"), ".kizuki", "kizuki.db"));
  try {
    expect(restored.query("SELECT status,revision FROM source_grants WHERE source_key=?").get(key)).toEqual({ status: "active", revision: 1 });
    expect(restored.query("SELECT count(*) AS n FROM source_event_bindings").get()).toEqual({ n: 1 });
    // Connector state is not part of a snapshot, so the source restores disconnected.
    expect(restored.query("SELECT count(*) AS n FROM connections WHERE disconnected_at IS NULL").get()).toEqual({ n: 0 });
  } finally { restored.close(); }
});

test("a snapshot refuses while a source revocation is still purging", async () => {
  const f = fixture();
  const key = f.source();
  accept(f.db, { ...validEvent(), connector_id: "kizuki.fixture", text: "Synthetic evidence." }, { source: { source_key: key, expected_revision: 1 } });
  revokeSourceGrant(f.db, { source_key: key, expected_revision: 1, operation_id: "revoke-it" });
  await expect(backupVault(f.db, f.vault, f.at("snapshot"))).rejects.toThrow(`source_revocation_pending: source ${key}`);
});

test("a snapshot carries no agent authority, names the agents to re-enroll, and restores without them", async () => {
  const f = fixture();
  const { token } = addAgent(f.db, "example-agent");
  const manifest = await backupVault(f.db, f.vault, f.at("snapshot"));
  expect(manifest.agents).toEqual(["example-agent"]);
  const bytes = readFileSync(join(f.at("snapshot"), "ledger.db"));
  expect(bytes.includes(Buffer.from(new Bun.CryptoHasher("sha256").update(token).digest("hex")))).toBe(false);
  expect(bytes.includes(Buffer.from("example-agent"))).toBe(false);
  expect(restoreSnapshot(f.at("snapshot"), f.at("restored")).agents).toEqual(["example-agent"]);
  const restored = openLedger(join(f.at("restored"), ".kizuki", "kizuki.db"));
  try { expect(listAgents(restored)).toEqual([]); } finally { restored.close(); }
});

test("a pending canon write holds the snapshot until it completes, or fails it after the wait", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db));
  f.db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic receipt storage failure'); END");
  expect(() => write({ db: f.db, vault_path: f.vault }, claim)).toThrow("synthetic receipt storage failure");
  await expect(backupVault(f.db, f.vault, f.at("refused"), { wait_ms: 250 })).rejects.toThrow("canon_recovery_pending");
  const waiting = backupVault(f.db, f.vault, f.at("waited"), { wait_ms: 20_000 });
  await Bun.sleep(300);
  f.db.exec("DROP TRIGGER synthetic_receipt_failure");
  recoverCanonWrites({ db: f.db, vault_path: f.vault });
  const manifest = await waiting;
  expect(manifest.receipts).toBe(1);
  expect(verifySnapshot(f.at("waited")).receipts).toBe(1);
});

test("verification refuses a tampered, incomplete or padded snapshot", async () => {
  const f = fixture();
  await backupVault(f.db, f.vault, f.at("snapshot"));
  const { appendFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(join(f.at("snapshot"), "extra.txt"), "x");
  expect(() => verifySnapshot(f.at("snapshot"))).toThrow("does not list");
  rmSync(join(f.at("snapshot"), "extra.txt"));
  appendFileSync(join(f.at("snapshot"), "ledger.db"), "x");
  expect(() => verifySnapshot(f.at("snapshot"))).toThrow("snapshot file changed");
});
