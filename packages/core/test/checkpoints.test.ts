import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { readCheckpoint, writeCheckpoint } from "../src/ledger/checkpoints";
import {
  getCheckpoint,
  registerConnection,
  saveCheckpoint,
} from "../src/ledger/connections";

describe("checkpoints", () => {
  test("a missing checkpoint reads as null", () => {
    const db = openLedger(":memory:");
    expect(readCheckpoint(db, "fixture", "/somewhere")).toBeNull();
    db.close();
  });

  test("round-trips a cursor per (connector, source)", () => {
    const db = openLedger(":memory:");
    writeCheckpoint(db, "fixture", "/a", "cursor-a");
    writeCheckpoint(db, "fixture", "/b", "cursor-b");
    writeCheckpoint(db, "other", "/a", "cursor-other");

    expect(readCheckpoint(db, "fixture", "/a")).toBe("cursor-a");
    expect(readCheckpoint(db, "fixture", "/b")).toBe("cursor-b");
    expect(readCheckpoint(db, "other", "/a")).toBe("cursor-other");
    db.close();
  });

  test("rewriting a checkpoint replaces the stored cursor", () => {
    const db = openLedger(":memory:");
    writeCheckpoint(db, "fixture", "/a", "first");
    writeCheckpoint(db, "fixture", "/a", "second");
    expect(readCheckpoint(db, "fixture", "/a")).toBe("second");
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM checkpoints")
        .get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("thin wrappers and rich checkpoints share one row", () => {
    const db = openLedger(":memory:");
    const source = "01JJ0000000000000000000001";
    registerConnection(db, "fixture", source);
    writeCheckpoint(db, "fixture", source, "from-wrapper");
    expect(getCheckpoint(db, "fixture", source)).toMatchObject({
      source_key: source,
      cursor: "from-wrapper",
      mode: "sync",
    });

    saveCheckpoint(db, "fixture", source, "from-rich-api", "backfill", {
      stored: 1,
      duplicates: 0,
      errors: [],
      proposals_created: 0,
      withdrawn: 0,
      retractions_filed: 0,
      cursor: "from-rich-api",
    });
    expect(readCheckpoint(db, "fixture", source)).toBe("from-rich-api");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM checkpoints").get(),
    ).toEqual({ count: 1 });
    db.close();
  });
});
