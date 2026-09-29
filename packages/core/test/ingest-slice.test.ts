import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  Connector,
  Manifest,
  PurgePlan,
  SyncBatch,
} from "../src/contracts/connector";
import type { CaptureEventInput } from "../src/contracts/event";
import { registerConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { setSourceGrant } from "../src/ledger/source-grants";
import { runToCompletion } from "../src/ingest/run";
import { initStaging } from "../src/staging/proposals";
import { validEvent } from "./fixtures";

// A hundred committed batches on a loaded host outlast the default deadline.
setDefaultTimeout(30_000);

const SOURCE = "01JJ0000000000000000000002";
const BATCHES = 100;

function database() {
  const db = openLedger(":memory:");
  initStaging(db);
  registerConnection(db, "fixture", SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
    expected_revision: 0,
    operation_id: `fixture-${SOURCE}`,
    policy: {
      purposes: ["capture", "recall", "derive"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  return db;
}

/** Serves a fixed number of one-event pages; the cursor names the next page, so a resume is observable. */
class PagedConnector implements Connector {
  readonly cursors: (string | null)[] = [];
  constructor(
    private readonly pages: number,
    private readonly beforeBatch: (
      served: number,
    ) => Promise<void> | void = () => undefined,
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
  health(): never {
    throw new Error("not used by the ingest runner");
  }
  connect(): Promise<void> {
    return Promise.resolve();
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
    return Promise.resolve([]);
  }
  backfill(cursor: string | null): Promise<SyncBatch> {
    return this.page(cursor);
  }
  sync(cursor: string | null): Promise<SyncBatch> {
    return this.page(cursor);
  }

  private async page(cursor: string | null): Promise<SyncBatch> {
    await this.beforeBatch(this.cursors.length);
    this.cursors.push(cursor);
    const index =
      cursor === null ? 1 : Number(cursor.slice("page-".length)) + 1;
    if (index > this.pages) return { events: [], cursor };
    return {
      events: [{ ...validEvent(), source_record_id: `page-${index}` }],
      cursor: `page-${index}`,
      has_more: index < this.pages,
    };
  }
}

describe("runToCompletion in bounded slices", () => {
  test("a batch cap returns has_more and the next call resumes from the cursor", async () => {
    const db = database();
    try {
      const connector = new PagedConnector(BATCHES);
      const first = await runToCompletion(
        db,
        connector,
        "fixture",
        SOURCE,
        "sync",
        { slice: { max_batches: 10 } },
      );
      expect(first).toMatchObject({
        stored: 10,
        errors: [],
        cursor: "page-10",
        has_more: true,
      });
      expect(connector.cursors).toHaveLength(10);

      let calls = 1;
      let total = first.stored;
      for (let last = first; last.has_more === true; calls += 1) {
        last = await runToCompletion(db, connector, "fixture", SOURCE, "sync", {
          slice: { max_batches: 10 },
        });
        total += last.stored;
      }
      // The connector serves every page exactly once: nothing replays and nothing is missed.
      expect(total).toBe(BATCHES);
      expect(calls).toBe(10);
      expect(connector.cursors.slice(9, 11)).toEqual(["page-9", "page-10"]);
      expect(
        connector.cursors.filter((cursor) => cursor === "page-10"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a drained connector reports no has_more even under a slice", async () => {
    const db = database();
    try {
      const done = await runToCompletion(
        db,
        new PagedConnector(3),
        "fixture",
        SOURCE,
        "sync",
        { slice: { max_batches: 3 } },
      );
      expect(done).toMatchObject({ stored: 3, errors: [], cursor: "page-3" });
      expect("has_more" in done).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a deadline ends the call after the batch in flight, and always after at least one batch", async () => {
    const db = database();
    try {
      const slow = new PagedConnector(BATCHES, () => Bun.sleep(25));
      const timed = await runToCompletion(db, slow, "fixture", SOURCE, "sync", {
        slice: { deadline_ms: 120 },
      });
      expect(timed.has_more).toBe(true);
      expect(timed.stored).toBeGreaterThanOrEqual(1);
      expect(timed.stored).toBeLessThan(BATCHES / 2);

      const spent = await runToCompletion(db, slow, "fixture", SOURCE, "sync", {
        slice: { deadline_ms: 0 },
      });
      expect(spent).toMatchObject({ stored: 1, has_more: true });
    } finally {
      db.close();
    }
  });

  test("a stop request between batches ends the call within one batch", async () => {
    const db = database();
    try {
      let stop = false;
      const connector = new PagedConnector(BATCHES, (served) => {
        if (served === 4) stop = true;
      });
      const result = await runToCompletion(
        db,
        connector,
        "fixture",
        SOURCE,
        "sync",
        { stopRequested: () => stop },
      );
      // The request arrived while batch 5 was being read; that batch is filed, and none follows.
      expect(result).toMatchObject({
        stored: 5,
        errors: [],
        cursor: "page-5",
        has_more: true,
      });
      expect(connector.cursors).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  test("a stop request pending at the start reads no batch", async () => {
    const db = database();
    try {
      const connector = new PagedConnector(BATCHES);
      const result = await runToCompletion(
        db,
        connector,
        "fixture",
        SOURCE,
        "sync",
        { stopRequested: () => true },
      );
      expect(result).toMatchObject({ stored: 0, cursor: null, has_more: true });
      expect(connector.cursors).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the unsliced call keeps its contract: the batch ceiling is an error, not a yield", async () => {
    const db = database();
    try {
      const result = await runToCompletion(
        db,
        new PagedConnector(BATCHES),
        "fixture",
        SOURCE,
        "sync",
        { maxBatches: 3 },
      );
      expect(result.errors).toEqual(["run did not complete within 3 batches"]);
      expect("has_more" in result).toBe(false);
    } finally {
      db.close();
    }
  });
});
