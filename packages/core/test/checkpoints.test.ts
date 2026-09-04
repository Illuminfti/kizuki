import { describe, expect, test } from "bun:test";
import { setSourceGrant } from "../src/ledger/source-grants";
import { openLedger } from "../src/ledger/db";
import {
  readCheckpoint,
  readRailCursor,
  writeCheckpoint,
} from "../src/ledger/checkpoints";
import {
  getCheckpoint,
  registerConnection,
  saveCheckpoint,
} from "../src/ledger/connections";

const result = (cursor: string) => ({
  stored: 1,
  duplicates: 0,
  errors: [],
  proposals_created: 0,
  withdrawn: 0,
  retractions_filed: 0,
  cursor,
});

function connectedSource(db: ReturnType<typeof openLedger>, source: string): void {
  registerConnection(db, "fixture", source);
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: `fixture-${source}`, policy: {
    purposes: ["capture", "recall", "derive"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only",
    sensitivity_floor: "public",
  } });
}

describe("checkpoints", () => {
  test("a missing checkpoint reads as null", () => {
    const db = openLedger(":memory:");
    expect(readCheckpoint(db, "fixture", "/somewhere")).toBeNull();
    db.close();
  });

  test("a recorded connector run writes one matching checkpoint receipt", () => {
    const db = openLedger(":memory:");
    const source = "01JJ0000000000000000000001";
    connectedSource(db, source);

    saveCheckpoint(db, "fixture", source, "from-recorded-run", "backfill", result("from-recorded-run"));

    expect(readCheckpoint(db, "fixture", source)).toBe("from-recorded-run");
    expect(getCheckpoint(db, "fixture", source)).toMatchObject({ source_key: source, cursor: "from-recorded-run", mode: "backfill" });
    expect(db.query<{ count: number }, [string, string, string]>("SELECT COUNT(*) AS count FROM connection_runs WHERE connector_id=? AND source_key=? AND committed_cursor=?")
      .get("fixture", source, "from-recorded-run")).toEqual({ count: 1 });
    db.close();
  });

  test("rail cursors round-trip without a connections row", () => {
    const db = openLedger(":memory:");
    writeCheckpoint(db, "kizuki.producer.model", "extract", "cursor-a");
    writeCheckpoint(db, "kizuki.producer.model", "other", "cursor-other");

    expect(readRailCursor(db, "kizuki.producer.model", "extract")).toBe("cursor-a");
    expect(readRailCursor(db, "kizuki.producer.model", "other")).toBe("cursor-other");
    expect(readCheckpoint(db, "kizuki.producer.model", "extract")).toBeNull();
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM checkpoints").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  test("rewriting a rail cursor replaces the stored token", () => {
    const db = openLedger(":memory:");
    writeCheckpoint(db, "rail", "extract", "first");
    writeCheckpoint(db, "rail", "extract", "second");
    expect(readRailCursor(db, "rail", "extract")).toBe("second");
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rail_cursors").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("connector checkpoints stay on the connections foreign key", () => {
    const db = openLedger(":memory:");
    const source = "01JJ0000000000000000000001";
    registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-" + source, policy: { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
    saveCheckpoint(db, "fixture", source, "from-rich-api", "backfill", {
      stored: 1,
      duplicates: 0,
      errors: [],
      proposals_created: 0,
      withdrawn: 0,
      retractions_filed: 0,
      cursor: "from-rich-api",
    });
    expect(getCheckpoint(db, "fixture", source)).toMatchObject({
      source_key: source,
      cursor: "from-rich-api",
      mode: "backfill",
    });
    expect(readCheckpoint(db, "fixture", source)).toBe("from-rich-api");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM checkpoints").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      db.query("INSERT INTO checkpoints VALUES ('missing', ?, NULL, 'sync', 't', 't', '{}')").run(source),
    ).toThrow();
    db.close();
  });
});
