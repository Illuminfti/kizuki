import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportVault, restoreVault, verifyBackup, type ExportManifest } from "../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { initVault } from "../src/vault/init";
import { authenticateAgentCredential, enrollAgent } from "../src/agents/enrollment";
import { credentialCustodyQualified } from "./agents/custody-fixture";
import { fileProposal, getProposal, initStaging, type ProposalInput } from "../src/staging/proposals";
import fixture from "./fixtures/agent-enrollment-ledger16-backup.json";
import claimFixture from "./fixtures/agent-enrollment-ledger16-claim-backup.json";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function materialize(input: { files: Record<string, string> } = fixture): { root: string; backup: string; manifest: ExportManifest } {
  const root = mkdtempSync(join(tmpdir(), "kizuki-agent-backup-"));
  roots.push(root);
  const backup = join(root, "backup");
  for (const [path, text] of Object.entries(input.files)) {
    const target = join(backup, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, text, { mode: 0o600 });
  }
  return { root, backup, manifest: JSON.parse(input.files["manifest.json"]!) as ExportManifest };
}

const oldClaim = JSON.parse(claimFixture.files["claims/claims.jsonl"]) as ProposalInput & {
  claim_id: string; target: string | null; subjects: string[];
};
const oldProposal: ProposalInput = {
  kind: oldClaim.kind, target: oldClaim.target, body: oldClaim.body,
  frontmatter: oldClaim.frontmatter, provenance: oldClaim.provenance,
  subjects: oldClaim.subjects, producer: oldClaim.producer, confidence: oldClaim.confidence,
};

test("restores an actual ledger16 claim and preserves it when the historical write input is refused", () => {
  expect(claimFixture.writer_commit).toBe("c5a3aa54c366c1f0f8242448732a797663fb65c1");
  expect(claimFixture.bun_version).toBe("1.3.10");
  expect(Object.hasOwn(oldClaim, "content_hash")).toBe(false);
  const { root, backup, manifest } = materialize(claimFixture);
  expect(manifest.schema_versions.ledger).toBe(16);
  expect(verifyBackup(backup).manifest_sha256).toBe(manifest.manifest_sha256);
  const restored = join(root, "restored");
  expect(restoreVault(backup, restored)).toMatchObject({ events: 1, claims: 1 });
  const db = openLedger(join(restored, ".kizuki", "kizuki.db"));
  try {
    initStaging(db);
    const restoredProposal = getProposal(db, oldClaim.claim_id)!;
    expect(restoredProposal).toMatchObject({ ...oldProposal, proposal_id: oldClaim.claim_id, sensitivity: "private" });
    expect(restoredProposal.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.query("SELECT claim_id,content_hash FROM claims").all()).toEqual([
      { claim_id: oldClaim.claim_id, content_hash: restoredProposal.content_hash },
    ]);
    // Main now accepts sensitivity as a row label, not caller frontmatter.
    // Preserve old data; do not rewrite the fixture to manufacture retry compatibility.
    const before = db.query("SELECT * FROM claims").all();
    expect(() => fileProposal(db, oldProposal)).toThrow("frontmatter: sensitivity is unknown");
    expect(db.query("SELECT * FROM claims").all()).toEqual(before);
    expect(getProposal(db, oldClaim.claim_id)).toEqual(restoredProposal);
    expect(db.query("SELECT count(*) AS n FROM agent_enrollments").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test.if(credentialCustodyQualified)("upgrades genuine ledger16 rows through enrollment, lazy signature repair and portable restore", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-agent-legacy-claim-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault);
  const dbPath = join(vault, ".kizuki", "kizuki.db");
  // Exact old writer schema and rows: no current migration is run or reversed.
  const old = new Database(dbPath);
  let eventsBefore: unknown[];
  try {
    old.exec(readFileSync(new URL("./fixtures/agent-enrollment-ledger16-claim.sql", import.meta.url), "utf8"));
    expect(old.query("SELECT version FROM schema_version").get()).toEqual({ version: 16 });
    expect(old.query<{ name: string }, []>("PRAGMA table_info(claims)").all().some(row => row.name === "content_hash")).toBe(false);
    expect(old.query("SELECT name FROM sqlite_master WHERE name='agent_enrollments'").get()).toBeNull();
    eventsBefore = old.query("SELECT * FROM events ORDER BY event_id").all();
  } finally { old.close(true); }
  chmodSync(dbPath, 0o600);
  const credentials = join(vault, ".kizuki", "agent-credentials"); mkdirSync(credentials, { mode: 0o700 });
  const tokenRef = `file:${join(credentials, "legacy-reader.credential")}`;
  expect(enrollAgent(vault, {
    name: "legacy-reader", operation_id: "legacy-reader-0001", token_ref: tokenRef,
    grant: { ceiling: "public", types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false },
  })).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
  const db = openLedger(dbPath), backup = join(root, "current-backup");
  let signature: string;
  try {
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 17 });
    expect(db.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(eventsBefore);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(claims)").all().some(row => row.name === "content_hash")).toBe(false);
    expect(authenticateAgentCredential(db, tokenRef)?.kind).toBe("agent");
    initStaging(db);
    const migratedProposal = getProposal(db, oldClaim.claim_id)!;
    expect(migratedProposal).toMatchObject({ ...oldProposal, proposal_id: oldClaim.claim_id, sensitivity: "private" });
    signature = migratedProposal.content_hash;
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(db.query("SELECT claim_id,content_hash FROM claims").all()).toEqual([
      { claim_id: oldClaim.claim_id, content_hash: signature },
    ]);
    expect(exportVault(db, vault, backup).schema_versions.ledger).toBe(17);
  } finally { db.close(); }
  const restored = join(root, "restored");
  expect(restoreVault(backup, restored)).toMatchObject({ events: 1, claims: 1 });
  const target = openLedger(join(restored, ".kizuki", "kizuki.db"));
  try {
    initStaging(target);
    const restoredProposal = getProposal(target, oldClaim.claim_id)!;
    expect(restoredProposal).toMatchObject({ ...oldProposal, proposal_id: oldClaim.claim_id, content_hash: signature, sensitivity: "private" });
    const before = target.query("SELECT * FROM claims").all();
    expect(() => fileProposal(target, oldProposal)).toThrow("frontmatter: sensitivity is unknown");
    expect(target.query("SELECT * FROM claims").all()).toEqual(before);
    expect(getProposal(target, oldClaim.claim_id)).toEqual(restoredProposal);
    expect(target.query("SELECT * FROM events ORDER BY event_id").all()).toEqual(eventsBefore);
    for (const table of ["agents", "agent_grants", "agent_audit", "agent_enrollments"]) {
      expect(target.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(authenticateAgentCredential(target, tokenRef)).toBeNull();
  } finally { target.close(); }
});

function resign(backup: string, manifest: ExportManifest): void {
  const unsigned = {
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  const signed = {
    ...unsigned,
    manifest_sha256: new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex"),
  };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`);
  chmodSync(join(backup, "manifest.json"), 0o600);
}

test("restores genuine ledger16 writer output after the local enrollment migration", () => {
  expect(fixture.writer_commit).toBe("c5a3aa54c366c1f0f8242448732a797663fb65c1");
  expect(fixture.bun_version).toBe("1.3.10");
  const { root, backup, manifest } = materialize();
  expect(manifest.schema).toBe("kizuki.backup/v3");
  expect(manifest.schema_versions.ledger).toBe(16);
  expect(verifyBackup(backup).schema_versions.ledger).toBe(16);
  const target = join(root, "restored");
  expect(restoreVault(backup, target).events).toBe(1);
  const db = openLedger(join(target, ".kizuki", "kizuki.db"));
  try {
    expect(LEDGER_SCHEMA_VERSION).toBe(17);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 17 });
    const original = JSON.parse(fixture.files["ledger/events.jsonl"]) as Record<string, unknown>;
    expect(db.query("SELECT event_id,text,content_hash,text_hash,origin,origin_binding FROM events").get()).toEqual({
      event_id: original.event_id, text: original.text, content_hash: original.content_hash,
      text_hash: original.text_hash, origin: original.origin, origin_binding: original.origin_binding,
    });
    expect(readFileSync(join(target, "project.txt"), "utf8")).toBe(fixture.files["vault/project.txt"]);
    for (const table of ["agents", "agent_grants", "agent_audit", "agent_enrollments"]) {
      expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  } finally { db.close(); }
});

test.if(credentialCustodyQualified)("current writer excludes completed enrollment authority and real generated credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-agent-current-backup-")); roots.push(root);
  const vault = join(root, "vault"); initVault(vault);
  const dbPath = join(vault, ".kizuki", "kizuki.db");
  const initialized = openLedger(dbPath); initialized.close(); chmodSync(dbPath, 0o600);
  const credentialDir = join(vault, ".kizuki", "agent-credentials"); mkdirSync(credentialDir, { mode: 0o700 });
  const ref = `file:${join(credentialDir, "agent.credential")}`;
  const created = enrollAgent(vault, { name: "backup-agent", operation_id: "backup-agent-0001", token_ref: ref,
    grant: { ceiling: "public", types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false } });
  expect(created).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
  const token = (JSON.parse(readFileSync(ref.slice(5), "utf8")) as { token: string }).token;
  const db = openLedger(dbPath), backup = join(root, "backup");
  let verifier: string;
  try {
    expect(authenticateAgentCredential(db, ref)?.kind).toBe("agent");
    verifier = db.query<{ token_hash: string }, []>("SELECT token_hash FROM agents").get()!.token_hash;
    const manifest = exportVault(db, vault, backup);
    expect(manifest.schema_versions.ledger).toBe(17);
    const paths = Object.keys(manifest.files);
    expect(paths.some(path => /agent|credential|\.kizuki/.test(path))).toBe(false);
    for (const path of ["manifest.json", ...paths]) {
      const text = readFileSync(join(backup, path), "utf8");
      expect(text.includes(token), "backup excludes plaintext credential").toBe(false);
      expect(text.includes(verifier), "backup excludes authentication verifier").toBe(false);
    }
  } finally { db.close(); }
  expect(verifyBackup(backup).schema_versions.ledger).toBe(17);
  const restored = join(root, "restored"); restoreVault(backup, restored);
  const target = openLedger(join(restored, ".kizuki", "kizuki.db"));
  try {
    for (const table of ["agents", "agent_grants", "agent_audit", "agent_enrollments"]) {
      expect(target.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(authenticateAgentCredential(target, ref)).toBeNull();
    expect(existsSync(join(restored, ".kizuki", "agent-credentials", "agent.credential"))).toBe(false);
  } finally { target.close(); }
});

for (const schema of ["kizuki.backup/v2", "kizuki.backup/v3"] as const) {
  for (const ledger of [16, 17]) {
    test(`${schema} explicitly accepts the unchanged selected streams at ledger${ledger}`, () => {
      const { root, backup, manifest } = materialize();
      // Dispatch fixture: only the envelope changes. The preceding test keeps
      // genuine v3/16 writer bytes, including its original signature, intact.
      resign(backup, { ...manifest, schema, schema_versions: { ...manifest.schema_versions, ledger } });
      expect(verifyBackup(backup).schema_versions.ledger).toBe(ledger);
      expect(restoreVault(backup, join(root, "restored")).events).toBe(1);
    });
  }
  for (const ledger of [0, 15, 18, 99, 16.5, "16"]) {
    test(`${schema} refuses unsupported ledger version ${JSON.stringify(ledger)} before target publication`, () => {
      const { root, backup, manifest } = materialize();
      resign(backup, { ...manifest, schema, schema_versions: { ...manifest.schema_versions, ledger: ledger as number } });
      expect(() => verifyBackup(backup)).toThrow(/backup.*schema/);
      const target = join(root, "restored");
      expect(() => restoreVault(backup, target)).toThrow(/backup.*schema/);
      expect(existsSync(target)).toBe(false);
    });
  }
}

for (const ledger of [16, 17]) {
  test(`backup v1 cannot reinterpret ledger${ledger} as legacy event authority`, () => {
    const { root, backup, manifest } = materialize();
    resign(backup, { ...manifest, schema: "kizuki.backup/v1", schema_versions: { ...manifest.schema_versions, ledger } });
    expect(() => verifyBackup(backup)).toThrow("legacy backup ledger schema is invalid");
    expect(() => restoreVault(backup, join(root, "restored"))).toThrow("legacy backup ledger schema is invalid");
    expect(existsSync(join(root, "restored"))).toBe(false);
  });
}
