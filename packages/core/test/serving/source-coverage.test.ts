import { expect, spyOn, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { inspectSourceCoverage, readSourceCoverage } from "../../src/world/coverage";
import { worldFixture } from "./world-fixture";
import { disconnect, registerConnection } from "../../src/ledger/connections";

test("coverage filters hidden sources before reading their malformed checkpoints", async () => {
  const db = openLedger(":memory:");
  const decoding = spyOn(JSON, "parse");
  try {
    const seen = await worldFixture(db, { subject: "topic:seen" });
    const agent = addAgent(db, "coverage-reader", { ...OWNER_AGENT_GRANT, subjects: ["topic:seen"] });
    const ctx = { ...seen.ctx, principal: authenticate(db, agent.token)! };
    decoding.mockClear();
    const before = JSON.stringify(readSourceCoverage(ctx));
    const reads = decoding.mock.calls.length;
    expect(JSON.parse(before)).toHaveLength(1);
    const hidden = await worldFixture(db, { connector: "world.hidden", subject: "topic:hidden" });
    const now = new Date().toISOString();
    db.query(`INSERT INTO checkpoints (connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result,backfill_complete,backfill_cursor,sync_cursor)
      VALUES (?, ?, NULL, 'sync', ?, ?, '{}', 0, NULL, NULL)`).run("world.hidden", hidden.sourceKey, now, now);
    decoding.mockClear();
    expect(JSON.stringify(readSourceCoverage(ctx))).toBe(before);
    expect(decoding.mock.calls.length).toBe(reads);
    // Hidden evidence in an otherwise readable source must not change record counts.
    await worldFixture(db, { sourceKey: seen.sourceKey, subject: "topic:hidden" });
    expect(JSON.stringify(readSourceCoverage(ctx))).toBe(before);
  } finally { decoding.mockRestore(); db.close(); }
});

test("coverage uses readable evidence counts and occurrence instants", async () => {
  const db = openLedger(":memory:");
  try {
    const seen = await worldFixture(db);
    const report = readSourceCoverage(seen.ctx)[0]!;
    expect(report.ingested).toBe(1);
    expect(report.first_occurred_at).toEqual(report.last_occurred_at);
    expect(report.scanned).toBeNull();
  } finally { db.close(); }
});

test("coverage preserves occurrence bounds across supported offsets and submillisecond instants", async () => {
  const db = openLedger(":memory:");
  try {
    const seen = await worldFixture(db);
    for (const [id, at] of [["first", "2020-01-01T00:00:00.000000001+23:59"], ["last", "2040-01-01T00:00:00.123456789-23:59"]]) {
      expect(accept(db, { ...validEvent(), connector_id: "world.fixture", source_record_id: id!, occurred_at: at! },
        { source: { source_key: seen.sourceKey, expected_revision: 1 } }).status).toBe("stored");
    }
    expect(inspectSourceCoverage(db)[0]).toMatchObject({
      ingested: 3, first_occurred_at: "2020-01-01T00:00:00.000000001+23:59", last_occurred_at: "2040-01-01T00:00:00.123456789-23:59",
    });
  } finally { db.close(); }
});

test("owner diagnostics disclose never-run and disconnected sources without evidence", () => {
  const db = openLedger(":memory:");
  try {
    const source = "01JJ0000000000000000000002";
    registerConnection(db, "coverage.fixture", source);
    disconnect(db, "coverage.fixture", source);
    const report = inspectSourceCoverage(db)[0]!;
    expect(report).toMatchObject({ ingested: 0, scanned: null, backfill_state: "never_run", last_successful_pass_at: null });
    expect(report.blind_spots.map(spot => spot.reason)).toEqual(expect.arrayContaining(["disabled_source", "never_completed_pass"]));
  } finally { db.close(); }
});


test("owner coverage aggregates a synthetic 50000-record ledger without a filesystem inventory", async () => {
  const db = openLedger(":memory:");
  try {
    const seen = await worldFixture(db);
    db.transaction(() => {
      for (let i = 1; i < 50_000; i++) {
        const result = accept(db, { ...validEvent(), connector_id: "world.fixture", source_record_id: `coverage-record-${i}` },
          { source: { source_key: seen.sourceKey, expected_revision: 1 } });
        if (result.status !== "stored") throw new Error("synthetic coverage seed refused");
      }
    })();
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const report = inspectSourceCoverage(db);
      timings.push(performance.now() - start);
      expect(report[0]!.ingested).toBe(50_000);
      expect(report[0]!.scanned).toBeNull();
    }
    console.info(`source coverage 50000-record collection milliseconds: ${timings.map(n => n.toFixed(2)).join(", ")}`);
  } finally { db.close(); }
}, 120_000);
