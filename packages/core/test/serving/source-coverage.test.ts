import { expect, spyOn, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { validEvent } from "../fixtures";
import { inspectSourceCoverage, readSourceCoverage } from "../../src/world/coverage";
import { worldFixture } from "./world-fixture";
import { disconnect, registerConnection } from "../../src/ledger/connections";
import { rfc3339Instant } from "../../src/agents/time";
import { instantNanoSql, instantSecondSql } from "../../src/query/sql";
import { LIVE_PREDICATE } from "../../src/ledger/ledger";

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

test("coverage bounds agree with grant instant ordering at timestamp boundaries", async () => {
  const groups = [
    ["0001-01-01T00:00:00+23:59", "9999-12-31T23:59:59-23:59"],
    ["2026-04-01t00:00:00.000000001z", "2026-04-01T00:00:00.000000002+00:00"],
    ["2026-04-01T00:59:60Z", "2026-04-01T00:59:59.999999998Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T23:59:00+23:59"],
    ["2026-04-01T00:00:00.001Z", "2026-04-01T00:00:00Z"],
    ["2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00Z"],
  ];
  for (const inputs of groups) {
    const db = openLedger(":memory:");
    try {
      const seen = await worldFixture(db);
      for (const [i, at] of inputs.entries()) {
        expect(accept(db, { ...validEvent(), connector_id: "world.fixture", source_record_id: `boundary-${i}`, occurred_at: at },
          { source: { source_key: seen.sourceKey, expected_revision: 1 } }).status).toBe("stored");
      }
      const order = (at: string) => rfc3339Instant(at, "fixture");
      const all = [...inputs, validEvent().occurred_at].sort((a, b) => order(a).epochSecond - order(b).epochSecond || order(a).nanos - order(b).nanos || (a < b ? -1 : a > b ? 1 : 0));
      expect(inspectSourceCoverage(db)[0]).toMatchObject({ first_occurred_at: all[0], last_occurred_at: all.at(-1) });
    } finally { db.close(); }
  }
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
    const previous = db.query<{ ingested: number }, [string]>(`WITH eligible AS MATERIALIZED (
      SELECT printf('%012d:%09d:%s', ${instantSecondSql("events.occurred_at")} + 62167219200,
        ${instantNanoSql("events.occurred_at")}, events.occurred_at) AS bound
      FROM source_event_bindings b JOIN events ON events.event_id=b.event_id
      WHERE b.source_key=? AND ${LIVE_PREDICATE}
    ) SELECT count(*) AS ingested, min(bound), max(bound) FROM eligible`);
    const baseline: number[] = [];
    for (let i = 0; i < 3; i++) {
      const oldStart = performance.now();
      expect(previous.get(seen.sourceKey)!.ingested).toBe(50_000);
      baseline.push(performance.now() - oldStart);
      const start = performance.now();
      const report = inspectSourceCoverage(db);
      timings.push(performance.now() - start);
      expect(report[0]!.ingested).toBe(50_000);
      expect(report[0]!.scanned).toBeNull();
    }
    console.info(`source coverage 50000-record collection milliseconds: ${timings.map(n => n.toFixed(2)).join(", ")}`);
    console.info(`previous timestamp aggregation milliseconds: ${baseline.map(n => n.toFixed(2)).join(", ")}`);
  } finally { db.close(); }
}, 120_000);
