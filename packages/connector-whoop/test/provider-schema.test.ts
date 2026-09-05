import { expect, test } from "bun:test";
import { WhoopFixture } from "../src/testing";

test("official current workout without retired sport_id", async () => {
  const fixture = new WhoopFixture(1, { resources: ["workout"], fields: ["activity"], history_start: "2026-01-01T00:00:00Z" });
  delete fixture.records.workout[0]!.sport_id;
  fixture.records.workout[0]!.sport_name = "running";
  const port = await fixture.connected();
  const batch = await port.sync(null);
  expect(batch.status).toBeUndefined();
  expect(batch.events).toHaveLength(1);
});

test("official Z timezone designator", async () => {
  const fixture = new WhoopFixture(1, { resources: ["cycle"], fields: ["activity"], history_start: "2026-01-01T00:00:00Z" });
  fixture.records.cycle[0]!.timezone_offset = "Z";
  const port = await fixture.connected();
  const batch = await port.sync(null);
  expect(batch.status).toBeUndefined();
  expect(batch.events).toHaveLength(1);
});

test("official active cycle with omitted optional end", async () => {
  const fixture = new WhoopFixture(1, { resources: ["cycle"], fields: ["activity"], history_start: "2026-01-01T00:00:00Z" });
  delete fixture.records.cycle[0]!.end;
  const port = await fixture.connected();
  const batch = await port.sync(null);
  expect(batch.status).toBeUndefined();
  expect(batch.events).toHaveLength(1);
});


test('malformed selected activity still refuses without advancing', async () => {
  for (const mutation of [
    (r: Record<string, unknown>) => { r.sport_name = 12; },
    (r: Record<string, unknown>) => { delete r.sport_name; },
    (r: Record<string, unknown>) => { r.timezone_offset = '+99:00'; },
    (r: Record<string, unknown>) => { delete r.end; },
    (r: Record<string, unknown>) => { r.end = null; }
  ]) {
    const fixture = new WhoopFixture(1, { resources: ['workout'], fields: ['activity'], history_start: '2026-01-01T00:00:00Z' });
    mutation(fixture.records.workout[0]!);
    const port = await fixture.connected();
    const batch = await port.sync(null);
    expect(batch.status).toBe('unavailable');
    expect(batch.cursor).toBeNull();
    expect(batch.events).toEqual([]);
    await port.close();
  }
});
