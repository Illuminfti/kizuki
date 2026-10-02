import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, addAgent, revokeAgent } from "../../src/agents";
import { enrollAppAgent } from "../../src/agents/app-enrollment";
import { rebuildWorldLayer } from "../../src/derived";
import { exportVault, restoreVault } from "../../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { initializeEnrollmentLedger } from "../agents/custody-fixture";
import {
  reserveViewPartition,
  seedViewPartitions,
  viewPartitionOf,
} from "../../src/world/views/partitions";
import { issueWorldRef, worldNamespace } from "../../src/world/references";
import { WORLD_VIEW_TABLE_SPECS } from "../../src/world/tables/views";

setDefaultTimeout(60_000);

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

const HEX = (seed: string) => seed.repeat(64).slice(0, 64);
const count = (db: Database, table: string) =>
  db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

function ledger(path = ":memory:"): Database {
  const db = openLedger(path);
  disposers.push(() => db.close());
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-view-tables-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A namespace, a token bound to it and to one issued reference it depends on. */
function seedToken(db: Database, principalId: string, tag: string): { namespace: string; ref: string } {
  const namespace = HEX(tag).slice(0, 32);
  const ref = `${tag.repeat(43).slice(0, 42)}A`;
  db.query("INSERT INTO world_authorization_namespaces(namespace_id,principal_id,authorization) VALUES (?,?,?)").run(
    namespace,
    principalId,
    "{}",
  );
  db.query("INSERT INTO world_wire_refs(namespace_id,wire_ref,ref_kind) VALUES (?,?,'claim')").run(namespace, ref);
  db.query(
    "INSERT INTO world_view_tokens(token_hash,partition_id,namespace_id,query_digest,projection,fingerprint,bytes,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(HEX(tag), viewPartitionOf(db, principalId)!, namespace, HEX("a"), Buffer.from("{}"), HEX("b"), 2, "2026-01-01T00:00:00.000Z", "2026-01-01T00:15:00.000Z");
  db.query("INSERT INTO world_view_token_deps(token_hash,namespace_id,wire_ref) VALUES (?,?,?)").run(HEX(tag), namespace, ref);
  return { namespace, ref };
}

describe("the view tables", () => {
  test("app enrollment uses the shared identity activation and reserves a partition", () => {
    const vault = tempDir();
    initVault(vault);
    initializeEnrollmentLedger(join(vault, ".kizuki", "kizuki.db"));
    const enrolled = enrollAppAgent(vault, { name: "app-reader", operation_id: "view-app-enrollment", grant: OWNER_AGENT_GRANT });
    expect(enrolled.receipt.authority).toBe("active");
    const db = ledger(join(vault, ".kizuki", "kizuki.db"));
    expect(viewPartitionOf(db, enrolled.receipt.agent_id!)).toBe(1);
  });
  test("a new ledger has the four cache tables and a reservation for the owner", () => {
    const db = ledger();
    for (const spec of WORLD_VIEW_TABLE_SPECS) {
      expect(spec.class).toBe("cache");
      expect(
        db
          .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(spec.name),
      ).not.toBeNull();
    }
    expect(viewPartitionOf(db, "owner")).toBe(0);
    expect(count(db, "world_view_partitions")).toBe(1);
  });

  test("a ledger migrated from the previous version reserves the owner and every live agent, oldest first", () => {
    const dir = tempDir();
    const path = join(dir, "ledger.db");
    let db = openLedger(path);
    const first = addAgent(db, "first-reader", OWNER_AGENT_GRANT);
    const second = addAgent(db, "second-reader", OWNER_AGENT_GRANT);
    const gone = addAgent(db, "gone-reader", OWNER_AGENT_GRANT);
    revokeAgent(db, "gone-reader");
    db.exec(`
      DROP TABLE world_resume_handles; DROP TABLE world_view_token_deps; DROP TABLE world_view_tokens; DROP TABLE world_view_partitions;
      DROP TRIGGER world_view_agent_revoked; DROP TRIGGER world_view_agent_deleted;
      UPDATE schema_version SET version=${LEDGER_SCHEMA_VERSION - 1};`);
    db.close();
    db = ledger(path);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({
      version: LEDGER_SCHEMA_VERSION,
    });
    expect(viewPartitionOf(db, "owner")).toBe(0);
    expect(viewPartitionOf(db, first.agent.agent_id)).toBe(1);
    expect(viewPartitionOf(db, second.agent.agent_id)).toBe(2);
    expect(viewPartitionOf(db, gone.agent.agent_id)).toBeNull();
  });

  test("reserving is idempotent, hands out the lowest free partition, and a full vault never displaces anyone", () => {
    const db = ledger();
    expect(reserveViewPartition(db, "owner")).toBe(true);
    for (let index = 1; index < 64; index += 1)
      expect(reserveViewPartition(db, `principal-${index}`)).toBe(true);
    expect(count(db, "world_view_partitions")).toBe(64);
    expect(reserveViewPartition(db, "the-sixty-fifth")).toBe(false);
    expect(viewPartitionOf(db, "the-sixty-fifth")).toBeNull();
    expect(viewPartitionOf(db, "owner")).toBe(0);
    db.query(
      "DELETE FROM world_view_partitions WHERE principal_id='principal-7'",
    ).run();
    expect(reserveViewPartition(db, "the-sixty-fifth")).toBe(true);
    expect(viewPartitionOf(db, "the-sixty-fifth")).toBe(7);
    expect(viewPartitionOf(db, "principal-8")).toBe(8);
  });

  test("revoking an agent ends its reservation and erases its tokens and handles", () => {
    const db = ledger();
    const agent = addAgent(db, "reader", OWNER_AGENT_GRANT);
    seedViewPartitions(db);
    seedToken(db, agent.agent.agent_id, "c");
    expect(count(db, "world_view_tokens")).toBe(1);
    revokeAgent(db, "reader");
    expect(viewPartitionOf(db, agent.agent.agent_id)).toBeNull();
    expect(count(db, "world_view_tokens")).toBe(0);
    expect(count(db, "world_view_token_deps")).toBe(0);
  });

  test("a reference the payload names ending erases the token payload and its dependency rows", () => {
    const db = ledger();
    const kept = seedToken(db, "owner", "d");
    expect(count(db, "world_view_tokens")).toBe(1);
    db.query("INSERT INTO world_wire_refs(namespace_id,wire_ref,ref_kind) VALUES (?,?,'claim')").run(kept.namespace, `${"Q".repeat(42)}A`);
    db.query("DELETE FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?").run(kept.namespace, `${"Q".repeat(42)}A`);
    expect(count(db, "world_view_tokens")).toBe(1);
    db.query("DELETE FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?").run(kept.namespace, kept.ref);
    expect(count(db, "world_view_tokens")).toBe(0);
    expect(count(db, "world_view_token_deps")).toBe(0);
  });

  test("replacing a namespace, which is what narrowing a grant does, erases the tokens bound to it", () => {
    const db = ledger();
    const { namespace } = seedToken(db, "owner", "e");
    db.query(
      "DELETE FROM world_authorization_namespaces WHERE namespace_id=?",
    ).run(namespace);
    expect(count(db, "world_view_tokens")).toBe(0);
  });

  test("a rebuild empties tokens and handles and reserves again from the owner and the live agents", () => {
    const db = ledger();
    const agent = addAgent(db, "reader", OWNER_AGENT_GRANT);
    seedViewPartitions(db);
    seedToken(db, agent.agent.agent_id, "f");
    db.query(
      "DELETE FROM world_view_partitions WHERE principal_id='owner'",
    ).run();
    const { tables } = rebuildWorldLayer(db);
    expect(tables).toEqual(WORLD_VIEW_TABLE_SPECS.map((spec) => spec.name));
    expect(count(db, "world_view_tokens")).toBe(0);
    expect(viewPartitionOf(db, "owner")).toBe(0);
    expect(viewPartitionOf(db, agent.agent.agent_id)).toBe(1);
  });

  test("a backup carries no token or handle, and a restore starts with the owner's reservation alone", () => {
    const dir = tempDir();
    const vault = join(dir, "vault");
    mkdirSync(vault, { mode: 0o700 });
    initVault(vault);
    const db = ledger();
    const agent = addAgent(db, "reader", OWNER_AGENT_GRANT);
    seedViewPartitions(db);
    db.transaction(() => {
      const ns = worldNamespace(db, OWNER);
      const ref = issueWorldRef(db, ns, "principal", "owner");
      db.query(
        "INSERT INTO world_view_tokens(token_hash,partition_id,namespace_id,query_digest,projection,fingerprint,bytes,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(HEX("9"), viewPartitionOf(db, "owner")!, ns.id, HEX("a"), Buffer.from("{}"), HEX("b"), 2, "2026-01-01T00:00:00.000Z", "2026-01-01T00:15:00.000Z");
      db.query("INSERT INTO world_view_token_deps(token_hash,namespace_id,wire_ref) VALUES (?,?,?)").run(HEX("9"), ns.id, ref.token);
    }).immediate();
    expect(count(db, "world_view_tokens")).toBe(1);
    const manifest = exportVault(db, vault, join(dir, "backup"));
    expect(Object.keys(manifest.files).filter((name) => name.includes("world_view") || name.includes("resume"))).toEqual([]);
    restoreVault(join(dir, "backup"), join(dir, "restored"));
    const copy = ledger(join(dir, "restored", ".kizuki", "kizuki.db"));
    expect(count(copy, "world_view_tokens")).toBe(0);
    expect(count(copy, "world_resume_handles")).toBe(0);
    // A restore does not carry agents, so each one is enrolled again and reserves its partition then.
    expect(count(copy, "agents")).toBe(0);
    expect(viewPartitionOf(copy, "owner")).toBe(0);
    expect(count(copy, "world_view_partitions")).toBe(1);
  });
});
