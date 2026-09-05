import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { applyConnectionSensitivity } from "../src/sensitivity/store";
import { accept, readSince } from "../src/ledger/ledger";
import { openLedger } from "../src/ledger/db";
import { getConnection, registerConnection } from "../src/ledger/connections";
import { runBackfill } from "../src/ingest/run";
import { indexEvent, rebuildSearch } from "../src/search/indexer";
import { search } from "../src/search/query";
import { validEvent } from "./fixtures";

const SOURCE = "01JJ0000000000000000000001";

class FixtureConnector implements Connector {
  constructor(
    private readonly batch: SyncBatch,
    private readonly manifestValue: Manifest,
  ) {}

  manifest(): Manifest {
    return this.manifestValue;
  }

  health(): Promise<HealthReport> { return Promise.reject(new Error("unused")); }
  connect(_resolve: SecretResolver): Promise<void> { return Promise.resolve(); }
  backfill(_cursor: string | null): Promise<SyncBatch> { return Promise.resolve(this.batch); }
  sync(_cursor: string | null): Promise<SyncBatch> { return Promise.resolve(this.batch); }
  revoke(): Promise<void> { return Promise.resolve(); }
  purgeSource(_subjectId: string): Promise<PurgePlan> {
    return Promise.resolve({ subject_id: "subject", source_record_ids: [], unreachable_source_record_ids: [] });
  }
  fixture(): Promise<CaptureEventInput[]> { return Promise.resolve(this.batch.events); }
}

function manifest(): Manifest {
  return {
    schema: "kizuki.connector/v1",
    connector_id: "fixture",
    version: "1.0.0",
    kinds: ["message"],
    capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true },
    required_secrets: [],
    emits_sensitivity_hint: true,
    default_sensitivity: "personal",
    sensitivity_floor: "personal",
    auth_modes: ["none"],
  };
}

function setup(
  event: CaptureEventInput,
  seeded = true,
  source = SOURCE,
  requested?: "private",
) {
  const db = openLedger(":memory:");
  const connection = registerConnection(db, "fixture", source);
  const configured = manifest();
  if (seeded) {
    applyConnectionSensitivity(db, connection, configured, requested);
  }
  return { db, connector: new FixtureConnector({ events: [event], cursor: null }, configured) };
}

describe("connector-run sensitivity resolution", () => {
  test("stores the connection default when a valid event omits its hint", async () => {
    const event = validEvent();
    delete event.sensitivity_hint;
    const { db, connector } = setup(event);
    const result = await runBackfill(db, connector, "fixture", SOURCE);
    expect(result.errors).toEqual([]);
    expect(readSince(db, null, 1).events[0]?.sensitivity_hint).toBe("personal");
    db.close();
  });

  test("only lets an event hint raise the connection label", async () => {
    const low = setup({ ...validEvent(), sensitivity_hint: "public" });
    await runBackfill(low.db, low.connector, "fixture", SOURCE);
    expect(readSince(low.db, null, 1).events[0]?.sensitivity_hint).toBe("personal");
    low.db.close();

    const high = setup({ ...validEvent(), sensitivity_hint: "private" });
    await runBackfill(high.db, high.connector, "fixture", SOURCE);
    expect(readSince(high.db, null, 1).events[0]?.sensitivity_hint).toBe("private");
    high.db.close();
  });

  test("keeps malformed hints invalid and defaults unseeded connections to private", async () => {
    const malformed = setup({ ...validEvent(), sensitivity_hint: "secret" as never });
    const rejected = await runBackfill(malformed.db, malformed.connector, "fixture", SOURCE);
    expect(rejected.errors).toEqual(["sensitivity_hint: must be one of public | personal | private"]);
    expect(readSince(malformed.db, null, 1).events).toEqual([]);
    malformed.db.close();

    const unseeded = setup(validEvent(), false);
    await runBackfill(unseeded.db, unseeded.connector, "fixture", SOURCE);
    expect(readSince(unseeded.db, null, 1).events[0]?.sensitivity_hint).toBe("private");
    unseeded.db.close();
  });

  test("keeps direct acceptance unlabeled and denies a private import to a personal search", async () => {
    const direct = openLedger(":memory:");
    const directEvent = { ...validEvent(), text: "direct-unlabeled" };
    delete directEvent.sensitivity_hint;
    const accepted = accept(direct, directEvent);
    expect(accepted.status).toBe("stored");
    if (accepted.status === "stored") indexEvent(direct, accepted.event);
    expect(search(direct, "direct-unlabeled", { ceiling: "private" })).toEqual([]);
    direct.close();

    const imported = setup({ ...validEvent(), text: "private-import", sensitivity_hint: "private" });
    await runBackfill(imported.db, imported.connector, "fixture", SOURCE);
    const event = readSince(imported.db, null, 1).events[0];
    if (event === undefined) throw new Error("expected imported event");
    indexEvent(imported.db, event);
    expect(search(imported.db, "private-import", { ceiling: "personal" })).toEqual([]);
    expect(search(imported.db, "private-import", { ceiling: "private" })).toHaveLength(1);
    imported.db.close();
  });

  test("keeps policies isolated by source_key and snapshots the first accepted label", async () => {
    const secondSource = "01JJ0000000000000000000002";
    const personal = setup({ ...validEvent(), source_record_id: "personal" });
    await runBackfill(personal.db, personal.connector, "fixture", SOURCE);
    const connection = registerConnection(personal.db, "fixture", secondSource);
    applyConnectionSensitivity(personal.db, connection, manifest(), "private");
    const privateConnector = new FixtureConnector(
      { events: [{ ...validEvent(), source_record_id: "private" }], cursor: null },
      manifest(),
    );
    await runBackfill(personal.db, privateConnector, "fixture", secondSource);
    const labels = readSince(personal.db, null, 10).events.map((event) => [
      event.source_record_id,
      event.sensitivity_hint,
    ]);
    expect(labels).toContainEqual(["personal", "personal"]);
    expect(labels).toContainEqual(["private", "private"]);

    const firstConnection = getConnection(personal.db, "fixture", SOURCE);
    if (firstConnection === null) throw new Error("expected first connection");
    applyConnectionSensitivity(personal.db, firstConnection, manifest(), "private");
    await runBackfill(personal.db, personal.connector, "fixture", SOURCE);
    expect(readSince(personal.db, null, 10).events).toHaveLength(2);
    expect(
      readSince(personal.db, null, 10).events.find(
        (event) => event.source_record_id === "personal",
      )?.sensitivity_hint,
    ).toBe("personal");
    personal.db.close();
  });

  test("rebuild preserves the accepted label instead of consulting current policy", async () => {
    const imported = setup({ ...validEvent(), text: "replay-private", sensitivity_hint: "private" });
    await runBackfill(imported.db, imported.connector, "fixture", SOURCE);
    const vault = mkdtempSync(join(tmpdir(), "kizuki-ingest-sensitivity-"));
    try {
      rebuildSearch(imported.db, vault);
      expect(search(imported.db, "replay-private", { ceiling: "personal" })).toEqual([]);
      expect(search(imported.db, "replay-private", { ceiling: "private" })).toHaveLength(1);
    } finally {
      rmSync(vault, { force: true, recursive: true });
      imported.db.close();
    }
  });
});
