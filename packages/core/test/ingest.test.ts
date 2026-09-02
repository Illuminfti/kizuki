import { describe, expect, test } from "bun:test";
import type {
  Connector,
  HealthReport,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "../src/contracts/connector";
import type { CaptureEventInput } from "../src/contracts/event";
import { getCheckpoint } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import {
  runBackfill,
  runBatch,
  runSync,
  runToCompletion,
} from "../src/ingest/run";
import { listProposals, initStaging } from "../src/staging/proposals";
import { validEvent } from "./fixtures";

class FixtureConnector implements Connector {
  readonly backfillCursors: (string | null)[] = [];
  readonly syncCursors: (string | null)[] = [];

  constructor(
    private readonly backfillBatch: SyncBatch,
    private readonly syncBatch: SyncBatch = { events: [], cursor: null },
  ) {}

  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1",
      connector_id: "fixture",
      version: "1.0.0",
      kinds: ["message"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: true,
        fixture: true,
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

function database() {
  const db = openLedger(":memory:");
  initStaging(db);
  return db;
}

describe("runBatch", () => {
  test("accepts events and files deterministic proposals", () => {
    const db = database();
    const result = runBatch(db, { events: [validEvent()], cursor: "page-2" });
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

  test("collects invalid-event errors and continues the batch", () => {
    const db = database();
    const invalid = { ...validEvent(), occurred_at: "not-a-time" };
    const result = runBatch(db, {
      events: [invalid, { ...validEvent(), source_record_id: "valid" }],
      cursor: null,
    });
    expect(result.stored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("occurred_at");
    db.close();
  });

  test("a tombstone withdraws proposals from prior source versions", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" });
    const result = runBatch(db, {
      events: [{ ...validEvent(), deleted: true, text: "" }],
      cursor: null,
    });
    expect(result.withdrawn).toBe(2);
    expect(listProposals(db, { status: "withdrawn" })).toHaveLength(2);
    expect(listProposals(db, { status: "pending" })).toEqual([]);
    db.close();
  });

  test("rolls back a tombstone when its cascade fails so retry can finish", () => {
    const db = database();
    runBatch(db, { events: [validEvent()], cursor: "one" });
    db.exec(`
      CREATE TRIGGER fail_withdraw
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'withdrawn'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END
    `);

    const failed = runBatch(db, {
      events: [{ ...validEvent(), deleted: true, text: "" }],
      cursor: "two",
    });
    expect(failed.stored).toBe(0);
    expect(failed.errors).toEqual(["forced cascade failure"]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
    ).toBe(1);
    expect(listProposals(db, { status: "pending" })).toHaveLength(2);

    db.exec("DROP TRIGGER fail_withdraw");
    const retried = runBatch(db, {
      events: [{ ...validEvent(), deleted: true, text: "" }],
      cursor: "two",
    });
    expect(retried.stored).toBe(1);
    expect(retried.withdrawn).toBe(2);
    expect(retried.errors).toEqual([]);
    db.close();
  });
});

describe("connector runs", () => {
  test("round-trips a fixture backfill and saves its checkpoint", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [validEvent()], cursor: "next" });
    expect(await connector.fixture()).toEqual([validEvent()]);
    const result = await runBackfill(db, connector, "fixture", "/source/a");
    expect(result.stored).toBe(1);
    expect(getCheckpoint(db, "fixture", "/source/a")?.last_result).toEqual(
      result,
    );
    expect(getCheckpoint(db, "fixture", "/source/a")?.mode).toBe("backfill");
    db.close();
  });

  test("a second backfill is all duplicates and creates no proposals", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [validEvent()], cursor: null });
    await runBackfill(db, connector, "fixture", "/source/a");
    const second = await runBackfill(db, connector, "fixture", "/source/a");
    expect(second.stored).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.proposals_created).toBe(0);
    expect(listProposals(db)).toHaveLength(2);
    db.close();
  });

  test("backfill resumes from the stored composite checkpoint", async () => {
    const db = database();
    const connector = new FixtureConnector({ events: [], cursor: "after-backfill" });
    await runBackfill(db, connector, "fixture", "/source/a");
    await runBackfill(db, connector, "fixture", "/source/a");
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
    await runBackfill(db, connector, "fixture", "/source/a");
    const synced = await runSync(db, connector, "fixture", "/source/a");
    expect(connector.syncCursors).toEqual(["resume-here"]);
    expect(synced.cursor).toBe("after-sync");
    expect(getCheckpoint(db, "fixture", "/source/a")?.mode).toBe("sync");
    expect(getCheckpoint(db, "fixture", "/source/a")?.last_result).toEqual(
      synced,
    );
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
    await runBackfill(db, connector, "fixture", "/source/a");
    db.exec(`
      CREATE TRIGGER fail_withdraw
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'withdrawn'
      BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END
    `);

    const failed = await runSync(db, connector, "fixture", "/source/a");
    expect(failed.errors).toEqual(["forced cascade failure"]);
    expect(getCheckpoint(db, "fixture", "/source/a")?.cursor).toBe(
      "before-tombstone",
    );

    db.exec("DROP TRIGGER fail_withdraw");
    const retried = await runSync(db, connector, "fixture", "/source/a");
    expect(retried.errors).toEqual([]);
    expect(retried.withdrawn).toBe(2);
    expect(connector.syncCursors).toEqual([
      "before-tombstone",
      "before-tombstone",
    ]);
    expect(getCheckpoint(db, "fixture", "/source/a")?.cursor).toBe(
      "after-tombstone",
    );
    db.close();
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
  test("drains every batch and saves the last cursor", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 2),
      page(2, 2),
      page(3, 1),
      { events: [], cursor: "page-3" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", "src-1", "backfill");
    expect(result.stored).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.cursor).toBe("page-3");
    expect(connector.cursors).toEqual([null, "page-1", "page-2", "page-3"]);
    expect(getCheckpoint(db, "fixture", "src-1")?.cursor).toBe("page-3");
    db.close();
  });

  test("stops on the first failing batch and keeps the earlier checkpoint", async () => {
    const db = database();
    const broken: SyncBatch = {
      events: [{ ...validEvent(), occurred_at: "not-a-time" }],
      cursor: "page-2",
    };
    const connector = new ScriptedConnector([page(1, 1), broken, page(3, 1)]);
    const result = await runToCompletion(db, connector, "fixture", "src-1", "backfill");
    expect(result.stored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.cursor).toBe("page-1");
    expect(getCheckpoint(db, "fixture", "src-1")?.cursor).toBe("page-1");
    expect(connector.cursors).toEqual([null, "page-1"]);
    db.close();
  });

  test("a non-empty batch that does not move the cursor is an error", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 1),
      { ...page(2, 1), cursor: "page-1" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", "src-1", "backfill");
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
      "src-1",
      "backfill",
      { maxBatches: 3 },
    );
    expect(result.errors).toEqual(["run did not complete within 3 batches"]);
    expect(result.stored).toBe(3);
    expect(result.cursor).toBe("page-3");
    db.close();
  });

  test("a batch that stores nothing but moves the cursor keeps going", async () => {
    const db = database();
    // What a paging connector does when a whole page holds only records it
    // does not emit: the cursor advances, the batch is empty, and there is
    // more behind it.
    const connector = new ScriptedConnector([
      { events: [], cursor: "page-1" },
      page(2, 2),
      { events: [], cursor: "page-2" },
    ]);
    const result = await runToCompletion(db, connector, "fixture", "src-1", "backfill");
    expect(result.stored).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.cursor).toBe("page-2");
    expect(connector.cursors).toEqual([null, "page-1", "page-2"]);
    db.close();
  });

  test("a connector that exhausts itself with a null cursor stops there", async () => {
    const db = database();
    const connector = new ScriptedConnector([
      page(1, 1),
      { events: [{ ...validEvent(), source_record_id: "last" }], cursor: null },
    ]);
    const result = await runToCompletion(db, connector, "fixture", "src-1", "backfill");
    expect(result.stored).toBe(2);
    expect(result.cursor).toBeNull();
    db.close();
  });
});
