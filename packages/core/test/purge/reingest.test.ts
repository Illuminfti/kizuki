import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector, HealthReport, Manifest, PurgePlan, SecretResolver, SyncBatch } from "../../src/contracts/connector";
import type { CaptureEventInput } from "../../src/contracts/event";
import { runSync } from "../../src/ingest/run";
import { getCheckpoint, registerConnection } from "../../src/ledger/connections";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { runPurge } from "../../src/ledger/purge";
import { findPurgeSuppression, liftPurgeSuppressions, listPurgeSuppressions } from "../../src/ledger/purge-suppression";
import { resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { initVault } from "../../src/vault/init";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";

setDefaultTimeout(30_000);
const AT = "2026-09-02T12:00:00.000Z";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-purge-reingest-"));
  roots.push(vault);
  initVault(vault);
  return { vault, db: openLedger(join(vault, ".kizuki", "kizuki.db")) };
}

function record(id: string, text: string, connector = "fixture"): CaptureEventInput {
  return { ...validEvent(), connector_id: connector, source_record_id: id, text };
}

function stored(db: ReturnType<typeof openLedger>, input: CaptureEventInput) {
  const result = accept(db, input);
  if (result.status !== "stored") throw new Error(`expected stored, got ${result.status}`);
  return result.event;
}

describe("a purged source record is not captured again silently", () => {
  test("accept refuses the record, keeps its neighbours, and names the purge receipt", async () => {
    const { vault, db } = fixture();
    const event = stored(db, record("notes/a.md", "first text"));
    const outcome = await runPurge(db, vault, { event_id: event.event_id }, "retire", { now: () => AT });
    const receipt = outcome.receipts[0]!.receipt_id;

    const edited = accept(db, record("notes/a.md", "first text, edited"));
    expect(edited).toEqual({ status: "suppressed", receipt_id: receipt });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(findPurgeSuppression(db, "fixture", "notes/a.md")).toBe(receipt);
    expect(accept(db, record("notes/b.md", "other record")).status).toBe("stored");
    expect(accept(db, record("notes/a.md", "same id, other connector", "fixture-two")).status).toBe("stored");
    expect(listPurgeSuppressions(db)).toEqual([
      { connector_id: "fixture", source_key: null, source_record_id: "notes/a.md", receipt_id: receipt, purged_at: AT },
    ]);
    db.close();
  });

  test("lifting allows the record again, and a later purge suppresses it again", async () => {
    const { vault, db } = fixture();
    const first = stored(db, record("notes/a.md", "first text"));
    const receipt = (await runPurge(db, vault, { event_id: first.event_id }, "retire", { now: () => AT })).receipts[0]!.receipt_id;
    expect(liftPurgeSuppressions(db, receipt, AT)).toEqual([receipt]);
    // Lifting twice finds nothing left to lift.
    expect(liftPurgeSuppressions(db, receipt, AT)).toEqual([]);

    const second = stored(db, record("notes/a.md", "second text"));
    const again = (await runPurge(db, vault, { event_id: second.event_id }, "retire again", { now: () => AT })).receipts[0]!.receipt_id;
    expect(again).not.toBe(receipt);
    expect(accept(db, record("notes/a.md", "third text"))).toEqual({ status: "suppressed", receipt_id: again });
    db.close();
  });

  test("a source authorization purge does not suppress its records", async () => {
    const { vault, db } = fixture();
    const source = ulid();
    registerConnection(db, "fixture", source);
    setSourceGrant(db, {
      source_key: source, expected_revision: 0, operation_id: "grant",
      policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
      },
    });
    const captured = accept(db, record("notes/a.md", "first text"), { source: { source_key: source, expected_revision: 1 } });
    expect(captured.status).toBe("stored");
    revokeSourceGrant(db, { source_key: source, expected_revision: 1, operation_id: "revoke" });
    await resumeSourceRevocation(db, vault, "revoke");
    expect(db.query("SELECT count(*) AS n FROM event_purges").get()).toEqual({ n: 1 });
    expect(findPurgeSuppression(db, "fixture", "notes/a.md")).toBeNull();
    db.close();
  });

  test("the refusal is keyed by the source: a second source of one connector is not refused", async () => {
    const { vault, db } = fixture();
    const grant = (): string => {
      const key = ulid();
      registerConnection(db, "fixture", key);
      setSourceGrant(db, {
        source_key: key, expected_revision: 0, operation_id: `grant-${key}`,
        policy: {
          purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
        },
      });
      return key;
    };
    const [first, second] = [grant(), grant()];
    const captured = accept(db, record("notes/todo.md", "first source text"), { source: { source_key: first, expected_revision: 1 } });
    if (captured.status !== "stored") throw new Error("expected stored");
    const receipt = (await runPurge(db, vault, { event_id: captured.event.event_id }, "retire", { now: () => AT })).receipts[0]!.receipt_id;

    expect(accept(db, record("notes/todo.md", "edited"), { source: { source_key: first, expected_revision: 1 } }))
      .toEqual({ status: "suppressed", receipt_id: receipt });
    expect(accept(db, record("notes/todo.md", "other source text"), { source: { source_key: second, expected_revision: 1 } }).status).toBe("stored");
    // A capture that names no source is refused: the check fails closed.
    expect(findPurgeSuppression(db, "fixture", "notes/todo.md")).toBe(receipt);
    expect(listPurgeSuppressions(db)).toMatchObject([{ source_key: first, source_record_id: "notes/todo.md" }]);
    db.close();
  });

  test("sync reports the refusal, advances the cursor, and still stores the other records", async () => {
    const { vault, db } = fixture();
    const source = ulid();
    registerConnection(db, "fixture", source);
    setSourceGrant(db, {
      source_key: source, expected_revision: 0, operation_id: "grant",
      policy: {
        purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
      },
    });
    const gone = stored(db, record("notes/gone.md", "text to purge"));
    await runPurge(db, vault, { event_id: gone.event_id }, "retire", { now: () => AT });

    const batch: SyncBatch = { events: [record("notes/gone.md", "text to purge, edited"), record("notes/new.md", "new text")], cursor: "page-2" };
    const connector: Connector = {
      manifest: (): Manifest => ({
        schema: "kizuki.connector/v1", connector_id: "fixture", version: "1.0.0", kinds: ["message"],
        capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true },
        required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["none"],
      }),
      health: (): Promise<HealthReport> => { throw new Error("unused"); },
      connect: (_resolve: SecretResolver) => Promise.resolve(),
      backfill: () => Promise.resolve(batch),
      sync: () => Promise.resolve(batch),
      revoke: () => Promise.resolve(),
      purgeSource: (subject_id: string): Promise<PurgePlan> =>
        Promise.resolve({ subject_id, source_record_ids: [], unreachable_source_record_ids: [] }),
      fixture: () => Promise.resolve(batch.events),
    };
    const result = await runSync(db, connector, "fixture", source);
    expect(result).toMatchObject({ stored: 1, duplicates: 0, suppressed: 1, errors: [], cursor: "page-2" });
    expect(getCheckpoint(db, "fixture", source)?.sync_cursor).toBe("page-2");
    expect(db.query("SELECT source_record_id FROM events").all()).toEqual([{ source_record_id: "notes/new.md" }]);
    db.close();
  });
});

describe("ledger migration 34", () => {
  test("a fresh ledger and an upgraded v33 ledger both carry the purge tables", () => {
    const { vault, db } = fixture();
    const names = () => db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name IN ('purge_erasures','purge_claim_scope','purge_suppression_lifts','purge_suppression_sources','event_purge_proofs_by_record') ORDER BY name",
    ).all().map((row) => row.name);
    const expected = ["event_purge_proofs_by_record", "purge_claim_scope", "purge_erasures", "purge_suppression_lifts", "purge_suppression_sources"];
    expect(LEDGER_SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
    expect(names()).toEqual(expected);

    db.exec("DROP TABLE purge_erasures; DROP TABLE purge_claim_scope; DROP TABLE purge_suppression_lifts; DROP TABLE purge_suppression_sources; DROP INDEX event_purge_proofs_by_record; UPDATE schema_version SET version = 33");
    db.close();
    const upgraded = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
      expect(upgraded.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name IN ('purge_erasures','purge_claim_scope','purge_suppression_lifts','purge_suppression_sources','event_purge_proofs_by_record') ORDER BY name",
      ).all().map((row) => row.name)).toEqual(expected);
    } finally { upgraded.close(); }
  });
});
