import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { readCheckpoint, writeCheckpoint } from "../src/ledger/checkpoints";

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
});
