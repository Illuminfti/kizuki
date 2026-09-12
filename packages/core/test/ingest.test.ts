import { setSourceGrant } from "../src/ledger/source-grants";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  HealthReport,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "../src/contracts/connector";
import type { CaptureEventInput } from "../src/contracts/event";
import {
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
} from "../src/contracts/page-candidate";
import { getCheckpoint, listConnectionRuns, registerConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { accept } from "../src/ledger/ledger";
import {
  runBackfill,
  runBatch,
  runSync,
  runToCompletion,
} from "../src/ingest/run";
import { listProposals, initStaging } from "../src/staging/proposals";
import { validEvent } from "./fixtures";
import { getClaim } from "../src/claims/store";
import { write } from "./canon/helpers";
import { tempVault } from "./helpers/vault";

type ManifestOverrides = Partial<Pick<Manifest, "connector_id" | "kinds">> & {
  page_candidates?: boolean;
  sync_from_backfill_before_first_success?: boolean;
};

class FixtureConnector implements Connector {
  readonly backfillCursors: (string | null)[] = [];
  readonly syncCursors: (string | null)[] = [];

  constructor(
    private readonly backfillBatch: SyncBatch,
    private readonly syncBatch: SyncBatch = { events: [], cursor: null },
    private readonly declared: ManifestOverrides = {},
  ) {}

  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1",
      connector_id: this.declared.connector_id ?? "fixture",
      version: "1.0.0",
      kinds: this.declared.kinds ?? ["message"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: true,
        fixture: true,
        ...(this.declared.page_candidates === undefined
          ? {}
          : { page_candidates: this.declared.page_candidates }),
        ...(this.declared.sync_from_backfill_before_first_success === undefined
          ? {}
          : {
              sync_from_backfill_before_first_success:
                this.declared.sync_from_backfill_before_first_success,
            }),
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      auth_modes: ["none"],
    };
  }

  health(): Promise<HealthReport> {
    throw new Error("not used by the ingest runner");
  }

  connect(_resolve: SecretResolver): Promise<void> {
    return Promise.resolve();
  }

  backfill(cursor: string | null): Promise<SyncBatch> {
    this.backfillCursors.push(cursor);
    return Promise.resolve(this.backfillBatch);
  }

  sync(cursor: string | null): Promise<SyncBatch> {
    this.syncCursors.push(cursor);
    return Promise.resolve(this.syncBatch);
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }

  purgeSource(subject_id: string): Promise<PurgePlan> {
    return Promise.resolve({
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
  }

  fixture(): Promise<CaptureEventInput[]> {
    return Promise.resolve(this.backfillBatch.events);
  }
}

/** The grant a caller with no page authority names. */
const NOTHING = { page_candidates: false } as const;

test.each(["backfill", "sync", "completion"] as const)(
  "host vault context reaches source retraction through %s", async mode => {
    const db = database();
    const vault = tempVault("kizuki-tombstone-ingest-");
    try {
      const capture = new FixtureConnector({ events: [validEvent()], cursor: null });
      expect((await runBackfill(db, capture, "fixture", SOURCE)).errors).toEqual([]);
      const proposal = listProposals(db, { kind: "claim" })[0]!;
      const io = { db, vault_path: vault.path };
      const original = write(io, getClaim(db, proposal.proposal_id)!);
      const batch = { events: [{ ...validEvent(), deleted: true, text: "Source deleted" }], cursor: null };
      const connector = new FixtureConnector(batch, batch);
      const result = mode === "backfill" ? await runBackfill(db, connector, "fixture", SOURCE, io) :
        mode === "sync" ? await runSync(db, connector, "fixture", SOURCE, io) :
        await runToCompletion(db, connector, "fixture", SOURCE, "sync", io);
      expect(result).toMatchObject({ errors: [], stored: 1, retractions_filed: 1, withdrawn: 1 });
      const deletion = listProposals(db, { kind: "deletion" })[0]!;
      expect(write(io, getClaim(db, deletion.proposal_id)!)).toMatchObject({
        page_action: "archive", page_path: original.page_path,
      });
    } finally { db.close(); vault.dispose(); }
  },
);

test("a refused retraction rolls back tombstone admission and retries before advancing the checkpoint", async () => {
  const db = database();
  const vault = tempVault("kizuki-tombstone-retry-");
  try {
    const captured = await runBackfill(db, new FixtureConnector({ events: [validEvent()], cursor: "before-delete" }), "fixture", SOURCE);
    expect(captured.errors).toEqual([]);
    const proposal = listProposals(db, { kind: "claim" })[0]!;
    const io = { db, vault_path: vault.path };
    write(io, getClaim(db, proposal.proposal_id)!);
    const batch = { events: [{ ...validEvent(), deleted: true, text: "Source deleted" }], cursor: null };
    const connector = new FixtureConnector(batch, batch);
    const refused = await runToCompletion(db, connector, "fixture", SOURCE, "sync");
    expect(refused).toMatchObject({ stored: 0, duplicates: 0, retractions_filed: 0,
      errors: ["source_tombstone_vault_required"] });
    expect(db.query("SELECT count(*) AS n FROM events WHERE deleted=1").get()).toEqual({ n: 0 });
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_cursor).toBe("before-delete");
    expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBeNull();
    const retried = await runToCompletion(db, connector, "fixture", SOURCE, "sync", io);
    expect(retried).toMatchObject({ stored: 1, duplicates: 0, retractions_filed: 1, errors: [] });
    expect(db.query("SELECT count(*) AS n FROM events WHERE deleted=1").get()).toEqual({ n: 1 });
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    const deletion = listProposals(db, { kind: "deletion" })[0]!;
    expect(write(io, getClaim(db, deletion.proposal_id)!).page_action).toBe("archive");
  } finally { db.close(); vault.dispose(); }
});

function replaceSourcePurposes(db: ReturnType<typeof database>, purposes: string[], revision: number): void {
  setSourceGrant(db, { source_key: SOURCE, expected_revision: revision, operation_id: `fixture-purposes-${revision}`,
    policy: { purposes, allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
}

for (const promoted of [false, true]) {
  test(`capture-only deletion ${promoted ? "preserves a canon retraction for authorized retry" : "withdraws pending evidence and advances"}`, async () => {
    const db = database();
    const vault = tempVault("kizuki-capture-tombstone-");
    try {
      const io = { db, vault_path: vault.path };
      expect((await runBackfill(db, new FixtureConnector({ events: [validEvent()], cursor: "before-delete" }), "fixture", SOURCE)).errors).toEqual([]);
      if (promoted) {
        const claim = listProposals(db, { kind: "claim" })[0]!;
        write(io, getClaim(db, claim.proposal_id)!);
      }
      const before = ["claims", "proposals", "canon_receipts"].map(table => db.query(`SELECT * FROM ${table}`).all());
      replaceSourcePurposes(db, ["capture"], 1);
      const batch = { events: [{ ...validEvent(), deleted: true, text: "Source deleted" }], cursor: null };
      const connector = new FixtureConnector(batch, batch);
      const result = await runSync(db, connector, "fixture", SOURCE, io);
      if (promoted) {
        expect(result).toMatchObject({ stored: 0, withdrawn: 0, retractions_filed: 0, errors: ["source_access_denied"] });
        expect(db.query("SELECT 1 FROM events WHERE deleted=1").get()).toBeNull();
        expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_cursor).toBe("before-delete");
        expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBeNull();
        expect(["claims", "proposals", "canon_receipts"].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
        replaceSourcePurposes(db, ["capture", "derive"], 2);
        expect(await runSync(db, connector, "fixture", SOURCE, io)).toMatchObject({ stored: 1, withdrawn: 1, retractions_filed: 1, errors: [] });
        const deletion = listProposals(db, { kind: "deletion" })[0]!;
        expect(write(io, getClaim(db, deletion.proposal_id)!).page_action).toBe("archive");
      } else {
        expect(result).toMatchObject({ stored: 1, withdrawn: 2, retractions_filed: 0, errors: [] });
        expect(listProposals(db, { status: "pending" })).toEqual([]);
        expect(listProposals(db, { status: "withdrawn" })).toHaveLength(2);
      }
      expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM events WHERE deleted=1").get()).toEqual({ n: 1 });
      expect(await runSync(db, connector, "fixture", SOURCE, io)).toMatchObject({ stored: 0, duplicates: 1, retractions_filed: 0, errors: [] });
    } finally { db.close(); vault.dispose(); }
  });
}

test("removing capture permission refuses deletion before connector access", async () => {
  const db = database();
  try {
    expect((await runBackfill(db, new FixtureConnector({ events: [validEvent()], cursor: "before-delete" }), "fixture", SOURCE)).errors).toEqual([]);
    const before = ["events", "claims", "proposals"].map(table => db.query(`SELECT * FROM ${table}`).all());
    replaceSourcePurposes(db, ["recall"], 1);
    const batch = { events: [{ ...validEvent(), deleted: true, text: "Source deleted" }], cursor: null };
    const connector = new FixtureConnector(batch, batch);
    const result = await runSync(db, connector, "fixture", SOURCE);
    expect(result.errors).toHaveLength(1);
    expect(result.stored).toBe(0);
    expect(connector.syncCursors).toEqual([]);
    expect(["events", "claims", "proposals"].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("before-delete");
  } finally { db.close(); }
});

/** An event asking the floor to stage its text as a typed page, not a quote. */
function candidate(over: Partial<CaptureEventInput> = {}): CaptureEventInput {
  return {
    ...validEvent(),
    subjects: [],
    text: "UNQUOTED BODY",
    metadata: {
      [PAGE_CANDIDATE_KEY]: {
        schema: PAGE_CANDIDATE_SCHEMA,
        type: "topic",
        title: "Injected",
        target: "entities/injected",
        extensions: {},
        confidence: 1,
      },
    },
    ...over,
  };
}

const SOURCE = "01JJ0000000000000000000001";

function database(path = ":memory:") {
  const db = openLedger(path);
  initStaging(db);
  registerConnection(db, "fixture", SOURCE);
  setSourceGrant(db, { source_key: SOURCE, expected_revision: 0, operation_id: "fixture-" + SOURCE, policy: { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
  return db;
}

const OPT_IN = { sync_from_backfill_before_first_success: true } as const;

describe("runBatch", () => {
  test("accepts events and files deterministic proposals", () => {
    const db = database();
    const result = runBatch(db, { events: [validEvent()], cursor: "page-2" }, NOTHING);
    expect(result).toEqual({
      stored: 1,
      duplicates: 0,
      errors: [],
      proposals_created: 2,
      withdrawn: 0,
      retractions_filed: 0,
      cursor: "page-2",
    });
    expect(listProposals(db)).toHaveLength(2);
    db.close();
  });

  test("a multi-event batch lands in the main sqlite file after close", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-ingest-wal-"));
    const dbPath = join(directory, "ledger.sqlite");
    try {
      const db = openLedger(dbPath);
      initStaging(db);
      const events = Array.from({ length: 15 }, (_, i) => ({
        ...validEvent(),
        source_record_id: `rec-${i}`,
        text: `wal-batch-marker ${i}`,
      }));
      const result = runBatch(db, { events, cursor: null }, NOTHING);
      expect(result.errors).toEqual([]);
      expect(result.stored).toBe(15);
      db.close();
      expect(readFileSync(dbPath).includes(Buffer.from("wal-batch-marker"))).toBe(
        true,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a corrupt stored duplicate aborts the batch and does not store later events", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" }, NOTHING);
    db.exec("DROP TRIGGER events_identity_update; UPDATE events SET origin='self'");
    const result = runBatch(
      db,
      {
        events: [validEvent(), { ...validEvent(), source_record_id: "rec-2" }],
        cursor: "two",
      },
      NOTHING,
    );
    expect(result.stored).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors.some((error) => /invalid|corrupt|origin/i.test(error))).toBe(true);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count,
    ).toBe(1);
    db.close();
  });

  test("collects invalid-event errors and continues the batch", () => {
    const db = database();
    const invalid = { ...validEvent(), occurred_at: "not-a-time" };
    const result = runBatch(
      db,
      {
        events: [invalid, { ...validEvent(), source_record_id: "valid" }],
        cursor: null,
      },
      NOTHING,
    );
    expect(result.stored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("occurred_at");
    db.close();
  });

  test("a tombstone withdraws proposals from prior source versions", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" }, NOTHING);
    const result = runBatch(
      db,
      { events: [{ ...validEvent(), deleted: true, text: "" }], cursor: null },
      NOTHING,
    );
    expect(result.withdrawn).toBe(2);
    expect(listProposals(db, { status: "withdrawn" })).toHaveLength(2);
    expect(listProposals(db, { status: "pending" })).toEqual([]);
    db.close();
  });

  test("rolls back a tombstone when its cascade fails so retry can finish", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" }, NOTHING);
    db.exec(`
      CREATE TRIGGER fail_withdraw
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'withdrawn'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END
    `);

    const failed = runBatch(
      db,
      { events: [{ ...validEvent(), deleted: true, text: "" }], cursor: "two" },
      NOTHING,
    );
    expect(failed.stored).toBe(0);
    expect(failed.errors).toEqual(["forced cascade failure"]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
    ).toBe(1);
    expect(listProposals(db, { status: "pending" })).toHaveLength(2);

    db.exec("DROP TRIGGER fail_withdraw");
    const retried = runBatch(
      db,
      { events: [{ ...validEvent(), deleted: true, text: "" }], cursor: "two" },
      NOTHING,
    );
    expect(retried.stored).toBe(1);
    expect(retried.withdrawn).toBe(2);
    expect(retried.errors).toEqual([]);
    db.close();
  });

  test("a cascade failure does not skip later events in the batch", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" }, NOTHING);
    db.exec(`
      CREATE TRIGGER fail_withdraw
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'withdrawn'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END
    `);
    const result = runBatch(
      db,
      {
        events: [
          { ...validEvent(), deleted: true, text: "" },
          { ...validEvent(), source_record_id: "rec-2" },
        ],
        cursor: "two",
      },
      NOTHING,
    );
    expect(result.errors).toEqual(["forced cascade failure"]);
    expect(result.stored).toBe(1);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
    ).toBe(2);
    db.close();
  });
});

describe("connector runs", () => {
  test("round-trips a fixture backfill and saves its checkpoint", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [validEvent()], cursor: "next" });
    expect(await connector.fixture()).toEqual([validEvent()]);
    const result = await runBackfill(db, connector, "fixture", SOURCE);
    expect(result.stored).toBe(1);
    expect(getCheckpoint(db, "fixture", SOURCE)?.last_result).toEqual(
      result,
    );
    expect(getCheckpoint(db, "fixture", SOURCE)?.mode).toBe("backfill");
    db.close();
  });

  test("a second backfill is all duplicates and creates no proposals", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [validEvent()], cursor: null });
    await runBackfill(db, connector, "fixture", SOURCE);
    const second = await runBackfill(db, connector, "fixture", SOURCE);
    expect(second.stored).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.proposals_created).toBe(0);
    expect(listProposals(db)).toHaveLength(2);
    db.close();
  });

  test("backfill resumes from the stored composite checkpoint", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [], cursor: "after-backfill" });
    await runBackfill(db, connector, "fixture", SOURCE);
    await runBackfill(db, connector, "fixture", SOURCE);
    expect(connector.backfillCursors).toEqual([null, "after-backfill"]);
    db.close();
  });

  test("sync resumes from the stored cursor and replaces the checkpoint", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [validEvent()], cursor: "resume-here" },
      {
        events: [{ ...validEvent(), source_record_id: "rec-2" }],
        cursor: "after-sync",
      },
    );
    await runBackfill(db, connector, "fixture", SOURCE);
    const synced = await runSync(db, connector, "fixture", SOURCE);
    expect(connector.syncCursors).toEqual([null]);
    expect(synced.cursor).toBe("after-sync");
    expect(getCheckpoint(db, "fixture", SOURCE)?.mode).toBe("sync");
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_cursor).toBe("resume-here");
    expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBe("after-sync");
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_complete).toBe(false);
    expect(getCheckpoint(db, "fixture", SOURCE)?.last_result).toEqual(
      synced,
    );
    db.close();
  });

  test("a drained backfill stays complete after sync overwrites the mode", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [validEvent()], cursor: "drained", has_more: false },
      {
        events: [{ ...validEvent(), source_record_id: "rec-2" }],
        cursor: "after-sync",
      },
    );
    await runBackfill(db, connector, "fixture", SOURCE);
    expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
      mode: "backfill",
      backfill_complete: true,
    });
    const synced = await runSync(db, connector, "fixture", SOURCE);
    expect(synced.errors).toEqual([]);
    expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
      mode: "sync",
      cursor: "after-sync",
      backfill_complete: true,
    });
    db.close();
  });

  test("sync cannot mark an incomplete backfill complete", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [validEvent()], cursor: "more", has_more: true },
      {
        events: [{ ...validEvent(), source_record_id: "rec-2" }],
        cursor: "after-sync",
      },
    );
    await runBackfill(db, connector, "fixture", SOURCE);
    expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
      mode: "backfill",
      backfill_complete: false,
    });
    await runSync(db, connector, "fixture", SOURCE);
    expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
      mode: "sync",
      backfill_complete: false,
    });
    db.close();
  });

  test("sync retains its checkpoint until a failed tombstone cascade retries", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [validEvent()], cursor: "before-tombstone" },
      {
        events: [{ ...validEvent(), deleted: true, text: "" }],
        cursor: "after-tombstone",
      },
    );
    await runBackfill(db, connector, "fixture", SOURCE);
    db.exec(`
      CREATE TRIGGER fail_withdraw
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'withdrawn'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END
    `);

    const failed = await runSync(db, connector, "fixture", SOURCE);
    expect(failed.errors).toEqual(["forced cascade failure"]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_cursor).toBe(
      "before-tombstone",
    );
    expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBeNull();

    db.exec("DROP TRIGGER fail_withdraw");
    const retried = await runSync(db, connector, "fixture", SOURCE);
    expect(retried.errors).toEqual([]);
    expect(retried.withdrawn).toBe(2);
    expect(connector.syncCursors).toEqual([
      null,
      null,
    ]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBe(
      "after-tombstone",
    );
    expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_cursor).toBe(
      "before-tombstone",
    );
    db.close();
  });

  test("interleaved backfill and sync resume independently across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-mode-cursors-"));
    const path = join(directory, "ledger.sqlite");
    const db = openLedger(path);
    initStaging(db);
    registerConnection(db, "fixture", SOURCE);
    setSourceGrant(db, {
      source_key: SOURCE, expected_revision: 0, operation_id: "fixture-" + SOURCE,
      policy: {
        purposes: ["capture", "recall", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "public",
      },
    });
    const received = { backfill: [] as (string | null)[], sync: [] as (string | null)[] };
    const connector = new FixtureConnector({ events: [], cursor: null });
    connector.backfill = async (cursor) => {
      received.backfill.push(cursor);
      return { events: [], cursor: cursor === null ? "B1" : "B2" };
    };
    connector.sync = async (cursor) => {
      received.sync.push(cursor);
      return { events: [], cursor: cursor === null ? "S1" : "S2" };
    };
    await runBackfill(db, connector, "fixture", SOURCE);
    await runSync(db, connector, "fixture", SOURCE);
    db.close();
    const reopened = openLedger(path);
    initStaging(reopened);
    await runBackfill(reopened, connector, "fixture", SOURCE);
    await runSync(reopened, connector, "fixture", SOURCE);
    expect(received.backfill).toEqual([null, "B1"]);
    expect(received.sync).toEqual([null, "S1"]);
    expect(getCheckpoint(reopened, "fixture", SOURCE)).toMatchObject({
      backfill_cursor: "B2",
      sync_cursor: "S2",
      backfill_complete: false,
    });
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("default fixture first sync after backfill still receives null", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [], cursor: "B1" },
      { events: [], cursor: "S1" },
    );
    await runBackfill(db, connector, "fixture", SOURCE);
    await runSync(db, connector, "fixture", SOURCE);
    expect(connector.syncCursors).toEqual([null]);
    expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
      backfill_cursor: "B1",
      sync_cursor: "S1",
    });
    db.close();
  });

  test("opt-in first sync after backfill reopen receives the backfill token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-sync-bootstrap-"));
    let db = database(join(directory, "ledger.sqlite"));
    try {
      const connector = new FixtureConnector(
        { events: [], cursor: "B1" },
        { events: [], cursor: "S1" },
        OPT_IN,
      );
      await runBackfill(db, connector, "fixture", SOURCE);
      db.close();
      db = openLedger(join(directory, "ledger.sqlite"));
      initStaging(db);
      await runSync(db, connector, "fixture", SOURCE);
      expect(connector.syncCursors).toEqual(["B1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B1",
        sync_cursor: "S1",
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opt-in interleaved backfill and sync keep independent B1/B2 and S1/S2 tokens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-optin-mode-cursors-"));
    let db = database(join(directory, "ledger.sqlite"));
    const received = { backfill: [] as (string | null)[], sync: [] as (string | null)[] };
    const connector = new FixtureConnector({ events: [], cursor: null }, undefined, OPT_IN);
    connector.backfill = async (cursor) => {
      received.backfill.push(cursor);
      return { events: [], cursor: cursor === null ? "B1" : "B2" };
    };
    connector.sync = async (cursor) => {
      received.sync.push(cursor);
      return { events: [], cursor: cursor === "S1" ? "S2" : "S1" };
    };
    try {
      await runBackfill(db, connector, "fixture", SOURCE);
      await runSync(db, connector, "fixture", SOURCE);
      db.close();
      db = openLedger(join(directory, "ledger.sqlite"));
      initStaging(db);
      await runBackfill(db, connector, "fixture", SOURCE);
      await runSync(db, connector, "fixture", SOURCE);
      expect(received.backfill).toEqual([null, "B1"]);
      expect(received.sync).toEqual(["B1", "S1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B2",
        sync_cursor: "S2",
        backfill_complete: false,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a successful null sync suppresses backfill bootstrap after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-null-sync-bootstrap-"));
    let db = database(join(directory, "ledger.sqlite"));
    try {
      const first = new FixtureConnector(
        { events: [validEvent()], cursor: "B1", has_more: false },
        { events: [], cursor: null },
        OPT_IN,
      );
      await runBackfill(db, first, "fixture", SOURCE);
      expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_complete).toBe(true);
      const synced = await runSync(db, first, "fixture", SOURCE);
      expect(first.syncCursors).toEqual(["B1"]);
      expect(synced).toMatchObject({ errors: [], cursor: null });
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B1",
        sync_cursor: null,
        backfill_complete: true,
      });
      expect(
        listConnectionRuns(db, "fixture", SOURCE).some(
          (run) => run.mode === "sync" && run.status === "ok",
        ),
      ).toBe(true);
      db.close();
      db = openLedger(join(directory, "ledger.sqlite"));
      initStaging(db);
      const second = new FixtureConnector(
        { events: [], cursor: "B1" },
        { events: [], cursor: "S1" },
        OPT_IN,
      );
      await runSync(db, second, "fixture", SOURCE);
      expect(second.syncCursors).toEqual([null]);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B1",
        sync_cursor: "S1",
        backfill_complete: true,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opt-in first sync failure preserves the bootstrap token for retry", async () => {
    const db = database();
    try {
      const failing = new (class extends FixtureConnector {
        override sync(cursor: string | null): Promise<SyncBatch> {
          this.syncCursors.push(cursor);
          return Promise.reject(new Error("provider down"));
        }
      })({ events: [validEvent()], cursor: "B1", has_more: false }, undefined, OPT_IN);
      await runBackfill(db, failing, "fixture", SOURCE);
      expect(getCheckpoint(db, "fixture", SOURCE)?.backfill_complete).toBe(true);
      const failed = await runSync(db, failing, "fixture", SOURCE);
      expect(failed.errors).toEqual(["provider down"]);
      expect(failed.cursor).toBe("B1");
      expect(failing.syncCursors).toEqual(["B1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B1",
        sync_cursor: "B1",
        backfill_complete: true,
      });
      expect(
        listConnectionRuns(db, "fixture", SOURCE).filter((run) => run.mode === "sync"),
      ).toMatchObject([{ status: "failed", committed_cursor: "B1" }]);
      const later = new FixtureConnector(
        { events: [], cursor: "B2" },
        { events: [], cursor: "S2" },
        OPT_IN,
      );
      await runBackfill(db, later, "fixture", SOURCE);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B2",
        sync_cursor: "B1",
        backfill_complete: true,
      });
      await runSync(db, later, "fixture", SOURCE);
      expect(later.syncCursors).toEqual(["B1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBe("S2");
    } finally {
      db.close();
    }
  });

  test("opt-in first sync unavailable preserves the bootstrap token for retry", async () => {
    const db = database();
    try {
      const connector = new FixtureConnector(
        { events: [validEvent()], cursor: "B1", has_more: false },
        {
          events: [],
          cursor: "attempted",
          status: "unavailable",
          detail: "provider is down",
        },
        OPT_IN,
      );
      await runBackfill(db, connector, "fixture", SOURCE);
      const result = await runSync(db, connector, "fixture", SOURCE);
      expect(result.errors).toEqual(["provider is down"]);
      expect(result.cursor).toBe("B1");
      expect(connector.syncCursors).toEqual(["B1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)).toMatchObject({
        backfill_cursor: "B1",
        sync_cursor: "B1",
        backfill_complete: true,
      });
      const retry = new FixtureConnector(
        { events: [], cursor: "B1" },
        { events: [], cursor: "S1" },
        OPT_IN,
      );
      await runSync(db, retry, "fixture", SOURCE);
      expect(retry.syncCursors).toEqual(["B1"]);
      expect(getCheckpoint(db, "fixture", SOURCE)?.sync_cursor).toBe("S1");
    } finally {
      db.close();
    }
  });

  test("opt-in without a backfill cursor still starts sync at null", async () => {
    const db = database();
    try {
      const connector = new FixtureConnector(
        { events: [], cursor: "B1" },
        { events: [], cursor: "S1" },
        OPT_IN,
      );
      await runSync(db, connector, "fixture", SOURCE);
      expect(connector.syncCursors).toEqual([null]);
      expect(connector.backfillCursors).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/** A connector whose batches are scripted, the way a paging source behaves. */
class ScriptedConnector extends FixtureConnector {
  readonly cursors: (string | null)[] = [];
  #position = 0;

  constructor(private readonly batches: SyncBatch[]) {
    super({ events: [], cursor: null });
  }

  override backfill(cursor: string | null): Promise<SyncBatch> {
    this.cursors.push(cursor);
    const batch = this.batches[this.#position] ?? { events: [], cursor };
    this.#position += 1;
    return Promise.resolve(batch);
  }
}

function page(index: number, count: number): SyncBatch {
  const events: CaptureEventInput[] = [];
  for (let position = 0; position < count; position += 1) {
    events.push({
      ...validEvent(),
      source_record_id: `page-${index}-rec-${position}`,
    });
  }
  return { events, cursor: `page-${index}` };
}

describe("runToCompletion", () => {
  test("a terminal snapshot commits its nonnull checkpoint without another provider call", async () => {
    const db = database();
    try {
      const terminal = { ...page(1, 1), has_more: false } as SyncBatch;
      const connector = new ScriptedConnector([terminal, page(99, 1)]);
      const first = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
      expect(first).toMatchObject({ stored: 1, duplicates: 0, errors: [], cursor: "page-1" });
      expect(connector.cursors).toEqual([null]);
      expect(getCheckpoint(db, "fixture", SOURCE)?.last_result).toEqual(first);
      const replay = new ScriptedConnector([terminal, page(99, 1)]);
      expect(await runToCompletion(db, replay, "fixture", SOURCE, "backfill")).toMatchObject({ stored: 0, duplicates: 1, errors: [], cursor: "page-1" });
      expect(replay.cursors).toEqual(["page-1"]);
      expect(Object.keys(first).sort()).toEqual(["stored", "duplicates", "errors", "proposals_created", "withdrawn", "retractions_filed", "cursor"].sort());
    } finally { db.close(); }
  });

  test("has_more true preserves bounded pagination and legacy no-progress refusal", async () => {
    const db = database();
    try {
      const connector = new ScriptedConnector([{ ...page(1, 1), has_more: true } as SyncBatch, { ...page(2, 1), has_more: false } as SyncBatch]);
      expect(await runToCompletion(db, connector, "fixture", SOURCE, "backfill")).toMatchObject({ stored: 2, errors: [], cursor: "page-2" });
      expect(connector.cursors).toEqual([null, "page-1"]);
      const stuck = new ScriptedConnector([{ ...page(3, 1), cursor: "page-2", has_more: true } as SyncBatch]);
      expect((await runToCompletion(db, stuck, "fixture", SOURCE, "backfill")).errors).toEqual(["run made no progress"]);
    } finally { db.close(); }
  });

  test("an explicit empty has_more page continues while an unspecified empty page remains drained", async () => {
    const db = database();
    try {
      const continued = new ScriptedConnector([
        { events: [], cursor: "empty-page", has_more: true },
        { events: [validEvent()], cursor: "stored-page", has_more: false },
      ]);
      expect(await runToCompletion(db, continued, "fixture", SOURCE, "backfill")).toMatchObject({ stored: 1, errors: [], cursor: "stored-page" });
      expect(continued.cursors).toEqual([null, "empty-page"]);
      const legacy = new ScriptedConnector([{ events: [], cursor: "legacy-empty" }]);
      expect(await runToCompletion(db, legacy, "fixture", SOURCE, "sync")).toMatchObject({ stored: 0, errors: [], cursor: null });
      expect(legacy.cursors).toEqual([null]);
    } finally { db.close(); }
  });

  test("terminal failed and unavailable batches never commit their attempted cursor", async () => {
    for (const terminal of [
      { events: [{ ...validEvent(), occurred_at: "not-a-time" }], cursor: "failed", has_more: false },
      { events: [], cursor: "failed", status: "unavailable", detail: "fixture unavailable", has_more: false },
    ]) {
      const db = database();
      try {
        await runBackfill(db, new FixtureConnector(page(1, 1)), "fixture", SOURCE);
        const connector = new ScriptedConnector([terminal as SyncBatch, page(99, 1)]);
        const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
        expect(result.errors).toHaveLength(1); expect(result.cursor).toBe("page-1");
        expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-1");
        expect(connector.cursors).toEqual(["page-1"]);
      } finally { db.close(); }
    }
  });

  test("an events accessor is refused before it can mutate the admitted completion scalar", async () => {
    const db = database();
    try {
      const original = page(1, 1);
      const batch = { cursor: original.cursor, has_more: false } as SyncBatch;
      let reads = 0;
      Object.defineProperty(batch, "events", {
        enumerable: true,
        get() {
          reads += 1;
          batch.has_more = true;
          return original.events;
        },
      });
      const result = await runToCompletion(db, new FixtureConnector(batch), "fixture", SOURCE, "backfill");
      expect(result.errors).toEqual(["sync batch events must be an own data property"]);
      expect(result.stored).toBe(0);
      expect(result.cursor).toBeNull();
      expect(reads).toBe(0);
      expect(batch.has_more).toBe(false);
      expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    } finally { db.close(); }
  });

  test("an inherited completion flag on a later page cannot terminate a legacy batch", async () => {
    const db = database();
    try {
      expect(await runToCompletion(db, new ScriptedConnector([page(1, 1)]), "fixture", SOURCE, "backfill")).toMatchObject({
        stored: 1, errors: [], cursor: "page-1",
      });
      const inherited = Object.assign(Object.create({ has_more: false }), page(2, 1));
      inherited.cursor = "page-1";
      expect((await runToCompletion(db, new FixtureConnector(inherited), "fixture", SOURCE, "backfill")).errors).toEqual(["run made no progress"]);
    } finally { db.close(); }
  });

  test("a global inherited completion flag cannot terminate a legacy batch", async () => {
    const db = database();
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "has_more");
    try {
      Object.defineProperty(Object.prototype, "has_more", { value: false, configurable: true, writable: true });
      const connector = new ScriptedConnector([page(1, 1), { ...page(2, 1), cursor: "page-1" }]);
      const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
      expect(result.errors).toEqual(["run made no progress"]);
      expect(result.stored).toBe(2); expect(connector.cursors).toEqual([null, "page-1"]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(Object.prototype, "has_more");
      else Object.defineProperty(Object.prototype, "has_more", original);
      db.close();
    }
  });

  test("an inherited descriptor value cannot disguise a completion accessor as data", async () => {
    const db = database();
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let reads = 0;
    const batch = page(1, 1);
    Object.defineProperty(batch, "has_more", { get: () => { reads++; return false; } });
    try {
      Object.defineProperty(Object.prototype, "value", { value: false, configurable: true, writable: true });
      const result = await runToCompletion(db, new FixtureConnector(batch), "fixture", SOURCE, "backfill");
      expect(result.errors).toEqual(["sync batch has_more must be an own boolean data property"]);
      expect(result.stored).toBe(0); expect(result.cursor).toBeNull(); expect(reads).toBe(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
      if (original !== undefined) Object.defineProperty(Object.prototype, "value", original);
      db.close();
    }
  });

  test("forged completion metadata is refused before events without invoking accessors", async () => {
    let getterCalls = 0;
    for (const descriptor of [
      ...[undefined, null, 0, "false", {}].map(value => ({ value, enumerable: true })),
      { get: () => { getterCalls++; return false; }, enumerable: true },
    ]) {
      const db = database();
      try {
        const batch = page(1, 1); Object.defineProperty(batch, "has_more", descriptor);
        const result = await runToCompletion(db, new FixtureConnector(batch), "fixture", SOURCE, "backfill");
        expect(result.errors).toEqual(["sync batch has_more must be an own boolean data property"]);
        expect(result.stored).toBe(0); expect(result.cursor).toBeNull();
        expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
      } finally { db.close(); }
    }
    expect(getterCalls).toBe(0);
  });

  test("drains every batch and saves the last cursor", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 2),
      page(2, 2),
      page(3, 1),
      { events: [], cursor: "page-3" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.cursor).toBe("page-3");
    expect(connector.cursors).toEqual([null, "page-1", "page-2", "page-3"]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-3");
    db.close();
  });

  test("stops on the first failing batch and keeps the earlier checkpoint", async () => {
    const db = database();
    const broken: SyncBatch = {
      events: [{ ...validEvent(), occurred_at: "not-a-time" }],
      cursor: "page-2",
    };
    const connector = new ScriptedConnector([page(1, 1), broken, page(3, 1)]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.cursor).toBe("page-1");
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-1");
    expect(connector.cursors).toEqual([null, "page-1"]);
    db.close();
  });

  test("a non-empty batch that does not move the cursor is an error", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 1),
      { ...page(2, 1), cursor: "page-1" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.errors).toEqual(["run made no progress"]);
    expect(result.stored).toBe(2);
    db.close();
  });

  test("a run that will not settle stops at the stated bound", async () => {
    const db = database();
    const batches: SyncBatch[] = [];
    for (let index = 1; index <= 6; index += 1) batches.push(page(index, 1));
    const connector = new ScriptedConnector(batches);
    const result = await runToCompletion(
      db,
      connector,
      "fixture",
      SOURCE,
      "backfill",
      { maxBatches: 3 },
    );
    expect(result.errors).toEqual(["run did not complete within 3 batches"]);
    expect(result.stored).toBe(3);
    expect(result.cursor).toBe("page-3");
    db.close();
  });

  test("a bound that cannot stop a run is refused before one starts", async () => {
    const db = database();
    const connector = new ScriptedConnector([page(1, 1)]);
    for (const maxBatches of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(
        runToCompletion(db, connector, "fixture", SOURCE, "backfill", {
          maxBatches,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    // A bound that would never be reached is worse than no bound at all, so
    // the run does not begin and no checkpoint is touched.
    expect(connector.cursors).toEqual([]);
    expect(getCheckpoint(db, "fixture", SOURCE)).toBeNull();
    db.close();
  });

  test("an empty batch ends the run even when the cursor moved", async () => {
    const db = database();
    // A connector says it has nothing left to give by returning an empty
    // batch. Reading on because the cursor moved would leave a connector whose
    // cursor carries a clock spending the whole batch bound on a settled
    // source, and then calling that run a failure.
    const connector = new ScriptedConnector([
      { events: [], cursor: "page-1" },
      page(2, 2),
    ]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.cursor).toBe("page-1");
    expect(connector.cursors).toEqual([null]);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-1");
    db.close();
  });

  test("a settled sync whose cursor keeps moving still stops at once", async () => {
    const db = database();
    // The shape a connector that stamps the time of its last pass into the
    // cursor has: every call answers with an empty batch and a cursor that
    // differs from the one before it.
    let tick = 0;
    const connector = new (class extends FixtureConnector {
      readonly calls: (string | null)[] = [];

      override sync(cursor: string | null): Promise<SyncBatch> {
        this.calls.push(cursor);
        tick += 1;
        return Promise.resolve({ events: [], cursor: `pass-${tick}` });
      }
    })({ events: [], cursor: null });
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "sync");
    expect(result.errors).toEqual([]);
    expect(connector.calls).toEqual([null]);
    expect(result.cursor).toBe("pass-1");
    db.close();
  });

  test("duplicates are work, so a batch of them keeps the run going", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 1),
      { events: page(1, 1).events, cursor: "page-2" },
      { events: [], cursor: "page-3" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.cursor).toBe("page-3");
    db.close();
  });


  test("a connector that exhausts itself with a null cursor stops there", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 1),
      { events: [{ ...validEvent(), source_record_id: "last" }], cursor: null },
    ]);
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(2);
    expect(result.cursor).toBeNull();
    db.close();
  });

  test("a connector that throws keeps what the earlier batches stored", async () => {
    const db = database();
    const connector = new (class extends FixtureConnector {
      #position = 0;

      override backfill(cursor: string | null): Promise<SyncBatch> {
        this.backfillCursors.push(cursor);
        this.#position += 1;
        if (this.#position > 2) {
          return Promise.reject(new Error("the source is unreachable"));
        }
        return Promise.resolve(page(this.#position, 2));
      }
    })({ events: [], cursor: null });
    const result = await runToCompletion(db, connector, "fixture", SOURCE, "backfill");
    expect(result.stored).toBe(4);
    expect(result.errors).toEqual(["the source is unreachable"]);
    // The durable checkpoint is what a caller resumes from, so it is what the
    // interrupted run reports.
    expect(result.cursor).toBe("page-2");
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBe("page-2");
    db.close();
  });
});

/**
 * The grant belongs to the connection the host enrolled. These are the three
 * ways a batch can claim one that was never given to it.
 */
describe("a batch that does not match the enrolled connection", () => {
  test("a manifest naming another connector runs nothing", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [validEvent()], cursor: "next" },
      undefined,
      { connector_id: "elsewhere", page_candidates: true },
    );
    const result = await runBackfill(db, connector, "fixture", SOURCE);
    expect(result.errors).toEqual([
      "fixture: manifest connector_id does not match the enrolled connection",
    ]);
    expect(result.stored).toBe(0);
    expect(getCheckpoint(db, "fixture", SOURCE)?.cursor).toBeNull();
    expect(listProposals(db)).toEqual([]);
    db.close();
  });

  test("an event from another connector cannot borrow the page grant", async () => {
    const db = database();
    const connector = new FixtureConnector(
      {
        events: [candidate({ connector_id: "elsewhere" })],
        cursor: "next",
      },
      undefined,
      { page_candidates: true },
    );
    const result = await runBackfill(db, connector, "fixture", SOURCE);
    expect(result.errors).toEqual([
      "fixture: batch carries an event from another connector",
    ]);
    expect(result.stored).toBe(0);
    // The whole batch is refused, so the injected page never reaches staging.
    expect(listProposals(db)).toEqual([]);
    db.close();
  });

  test("a kind the manifest never declared refuses the batch", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [], cursor: null },
      {
        events: [
          validEvent(),
          { ...validEvent(), source_record_id: "b", kind: "page" },
        ],
        cursor: "next",
      },
    );
    const result = await runSync(db, connector, "fixture", SOURCE);
    expect(result.errors).toEqual([
      "fixture: batch carries a kind the manifest does not declare",
    ]);
    // Refusal is the whole batch: the well-formed event ahead of it is not
    // stored either, because the batch is what the connection vouched for.
    expect(result.stored).toBe(0);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
    ).toBe(0);
    db.close();
  });

  test("a matching batch still stages the page its manifest grants", async () => {
    const db = database();
    const connector = new FixtureConnector(
      { events: [candidate()], cursor: "next" },
      undefined,
      { page_candidates: true },
    );
    const result = await runBackfill(db, connector, "fixture", SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.proposals_created).toBe(1);
    const [staged] = listProposals(db);
    expect(staged?.target).toBe("entities/injected");
    expect(staged?.body).toBe("UNQUOTED BODY");
    db.close();
  });
});

describe("hostile live event records", () => {
  const CANARY = "private-body\u0007SECRET";

  function leakless(value: unknown) {
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain("private-body");
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("\u0007");
  }

  const shapes: [string, (hits: { n: number }) => CaptureEventInput][] = [
    [
      "text accessor",
      (hits) => {
        const event = { ...validEvent(), text: CANARY };
        Object.defineProperty(event, "text", {
          configurable: true,
          enumerable: true,
          get() {
            hits.n += 1;
            throw new Error(CANARY);
          },
        });
        return event as CaptureEventInput;
      },
    ],
    [
      "enumerable toJSON",
      (hits) => {
        const event = { ...validEvent(), text: CANARY };
        Object.defineProperty(event, "toJSON", {
          configurable: true,
          enumerable: true,
          value() {
            hits.n += 1;
            throw new Error(CANARY);
          },
        });
        return event as CaptureEventInput;
      },
    ],
  ];

  for (const [name, make] of shapes) {
    test(`accept, runBatch, runBackfill and runSync refuse ${name} without executing or leaking`, async () => {
      const hits = { n: 0 };
      const event = make(hits);

      const direct = openLedger(":memory:");
      try {
        const accepted = accept(direct, event);
        expect(accepted.status).toBe("error");
        if (accepted.status !== "error") throw new Error("unreachable");
        expect(accepted.kind).toBe("validation");
        leakless(accepted);
        expect(direct.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
      } finally {
        direct.close();
      }
      expect(hits.n).toBe(0);

      const batched = database();
      try {
        const result = runBatch(
          batched,
          { events: [event, { ...validEvent(), source_record_id: "rec-2" }], cursor: "stolen" },
          NOTHING,
        );
        expect(result.stored).toBe(0);
        expect(result.cursor).toBeNull();
        expect(result.errors.length).toBeGreaterThan(0);
        leakless(result);
        expect(batched.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
      } finally {
        batched.close();
      }
      expect(hits.n).toBe(0);

      const backfillDb = database();
      try {
        const result = await runBackfill(
          backfillDb,
          new FixtureConnector({ events: [event], cursor: "stolen" }),
          "fixture",
          SOURCE,
        );
        expect(result.stored).toBe(0);
        expect(result.cursor).toBeNull();
        leakless(result);
        leakless(getCheckpoint(backfillDb, "fixture", SOURCE));
        leakless(listConnectionRuns(backfillDb, "fixture", SOURCE));
        expect(getCheckpoint(backfillDb, "fixture", SOURCE)?.cursor).toBeNull();
      } finally {
        backfillDb.close();
      }
      expect(hits.n).toBe(0);

      const syncDb = database();
      try {
        expect(
          (await runBackfill(
            syncDb,
            new FixtureConnector({ events: [validEvent()], cursor: "kept" }),
            "fixture",
            SOURCE,
          )).stored,
        ).toBe(1);
        const result = await runSync(
          syncDb,
          new FixtureConnector({ events: [], cursor: null }, { events: [event], cursor: "stolen" }),
          "fixture",
          SOURCE,
        );
        expect(result.stored).toBe(0);
        expect(result.cursor).toBeNull();
        leakless(result);
        leakless(getCheckpoint(syncDb, "fixture", SOURCE));
        expect(getCheckpoint(syncDb, "fixture", SOURCE)?.backfill_cursor).toBe("kept");
        expect(getCheckpoint(syncDb, "fixture", SOURCE)?.sync_cursor).toBeNull();
      } finally {
        syncDb.close();
      }
      expect(hits.n).toBe(0);
    });
  }

  test("events-array toJSON and cursor accessors are refused without execution", async () => {
    const hits = { n: 0 };
    const events = [validEvent()];
    Object.defineProperty(events, "toJSON", {
      enumerable: true,
      value() {
        hits.n += 1;
        throw new Error(CANARY);
      },
    });
    const cursorBatch = { events: [validEvent()], cursor: "stolen" } as SyncBatch;
    Object.defineProperty(cursorBatch, "cursor", {
      enumerable: true,
      get() {
        hits.n += 1;
        throw new Error(CANARY);
      },
    });

    const db = database();
    try {
      const arrayResult = runBatch(db, { events, cursor: "stolen" }, NOTHING);
      expect(arrayResult.stored).toBe(0);
      leakless(arrayResult);
      expect(hits.n).toBe(0);

      const cursorResult = runBatch(db, cursorBatch, NOTHING);
      expect(cursorResult.stored).toBe(0);
      leakless(cursorResult);
      expect(hits.n).toBe(0);

      const backfill = await runBackfill(
        db,
        new FixtureConnector({ events, cursor: "stolen" }),
        "fixture",
        SOURCE,
      );
      expect(backfill.stored).toBe(0);
      expect(backfill.cursor).toBeNull();
      leakless(backfill);
      expect(hits.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a later plain batch still stores and is not mutated after a hostile refusal", () => {
    const db = database();
    const hits = { n: 0 };
    const hostile = shapes[0]![1](hits);
    expect(runBatch(db, { events: [hostile], cursor: "nope" }, NOTHING).stored).toBe(0);
    const plain = validEvent();
    const before = JSON.stringify(plain);
    const result = runBatch(db, { events: [plain], cursor: "ok" }, NOTHING);
    expect(result).toMatchObject({ stored: 1, errors: [], cursor: "ok" });
    expect(JSON.stringify(plain)).toBe(before);
    expect(hits.n).toBe(0);
    db.close();
  });
});
