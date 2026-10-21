import { expect, test } from "bun:test";
import { serveWorldView } from "@kizuki/core/world";
import { hiddenScene, observe } from "../helpers/noninterference";

test("a hidden source checkpoint cannot change card qualifiers, refusals or work counters", async () => {
  const scene = await hiddenScene();
  try {
    const input = { operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" } };
    const read = { name: "card coverage", run: (ctx: typeof scene.reader) => serveWorldView(ctx, input) };
    await observe(scene.reader, read);
    const before = await observe(scene.reader, read);
    const now = new Date().toISOString();
    scene.db.query(`INSERT INTO checkpoints (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
      VALUES ('world.fixture', ?, NULL, 'sync', ?, ?, ?, 0, NULL, NULL)`).run(scene.hidden.sourceKey, now, now,
      JSON.stringify({ stored: 0, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: null }));
    expect(await observe(scene.reader, read)).toEqual(before);
  } finally { scene.dispose(); }
}, 120_000);
