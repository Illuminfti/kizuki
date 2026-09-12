import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

const h = createHelpers(); afterEach(h.cleanup);
const BODY = "synthetic private archive message never shown in diagnostics";
const BAD = "SYNTHETIC_MALFORMED_CONVERSATION_SECRET";
const conversation = (id: string) => ({ id, title: "SYNTHETIC_PRIVATE_TITLE", create_time: 1700000000,
  mapping: { n: { message: { author: { role: "user" }, content: { parts: [BODY] }, create_time: 1700000001 }, parent: null, children: [] } } });
const claude = (id: string) => ({ uuid: id, name: "SYNTHETIC_PRIVATE_TITLE", chat_messages: [
  { uuid: "n", sender: "human", text: BODY, created_at: "2026-01-01T00:00:01Z" },
] });

function state(vault: string) {
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try { return {
    sources: db.query<{ source_key: string }, []>("SELECT source_key FROM connections").all(),
    events: db.query<{ event_id: string; source_record_id: string; deleted: number }, []>("SELECT * FROM events ORDER BY event_id").all(),
    runs: db.query<{ status: string; previous_cursor: string | null; committed_cursor: string | null; stored: number; duplicates: number; errors: string }, []>("SELECT status,previous_cursor,committed_cursor,stored,duplicates,errors FROM connection_runs ORDER BY rowid").all(),
    checkpoints: db.query<{ cursor: string | null; backfill_cursor: string | null; backfill_complete: number }, []>("SELECT cursor,backfill_cursor,backfill_complete FROM checkpoints").all(),
  }; } finally { db.close(); }
}
function expectSnapshotCursor(cursor: string | null, connector: string, source: string, offset: number, exhausted: boolean) {
  expect(JSON.parse(cursor ?? "null")).toEqual({
    schema: "kizuki.import-snapshot.cursor/v1", connector_id: `kizuki.${connector}`,
    export: { sha256: createHash("sha256").update(source).digest("hex"), size: Buffer.byteLength(source, "utf8") },
    offset, exhausted,
  });
}
function safeDiagnostics(result: { stdout: string; stderr: string }, source: string) {
  for (const forbidden of [BODY, BAD, "SYNTHETIC_PRIVATE_TITLE", "SYNTHETIC_PRIVATE_ID", source]) {
    expect(result.stdout + result.stderr).not.toContain(forbidden);
  }
}

for (const [connector, valid] of [["import-chatgpt", conversation], ["import-claude", claude]] as const) {
  test(`${connector} preserves valid records but refuses partial completion until the same source is corrected`, () => {
    const o = h.tempVault(), source = join(o.root, "synthetic-export.json"), original = JSON.stringify([valid("SYNTHETIC_PRIVATE_ID"), BAD]);
    writeFileSync(source, original);
    const first = h.runCli(o.env, "import", connector, "--source", source, ...fixtureConsent(o.root));
    expect(first.exitCode).toBe(1); expect(first.stdout).toContain("events_stored=1"); expect(first.stdout).toContain("duplicates=0"); expect(first.stdout).toContain("errors=1");
    expect(first.stderr).toContain("partial_import: 1 record errors (not_object=1)"); safeDiagnostics(first, source);
    expect(readFileSync(source, "utf8")).toBe(original);
    const initial = state(o.vault); expect(initial.events).toHaveLength(1); expect(initial.sources).toHaveLength(1);
    expect(initial.runs.map(run => run.status)).toEqual(["ok", "unavailable"]);
    expect(initial.runs[1]!.committed_cursor).toBe(initial.runs[0]!.committed_cursor);
    expect(JSON.parse(initial.runs[1]!.errors)).toEqual(["partial_import: 1 record errors (not_object=1)"]);
    const partialCursor = initial.runs[0]!.committed_cursor;
    expectSnapshotCursor(partialCursor, connector, original, 1, false);
    expect(initial.checkpoints).toEqual([{ cursor: partialCursor, backfill_cursor: partialCursor, backfill_complete: 0 }]);
    const repeat = h.runCli(o.env, "import", connector, "--source", source);
    expect(repeat.exitCode).toBe(1); expect(repeat.stdout).toContain("events_stored=0"); expect(repeat.stdout).toContain("duplicates=0"); safeDiagnostics(repeat, source);
    const repeated = state(o.vault);
    expect(repeated.runs.at(-1)).toMatchObject({ status: "unavailable", previous_cursor: partialCursor, committed_cursor: partialCursor, stored: 0, duplicates: 0 });
    expect(repeated.events).toEqual(initial.events); expect(repeated.sources).toEqual(initial.sources); expect(repeated.checkpoints).toEqual(initial.checkpoints);
    expect(readFileSync(source, "utf8")).toBe(original);
    // A changed digest must restart before the old offset, then let the ledger
    // deduplicate the retained record without minting another revision.
    const repairedSource = JSON.stringify([valid("repaired-conversation"), valid("SYNTHETIC_PRIVATE_ID")]);
    writeFileSync(source, repairedSource);
    const repaired = h.runCli(o.env, "import", connector, "--source", source);
    expect(repaired.exitCode, repaired.stderr).toBe(0); expect(repaired.stdout).toContain("events_stored=1"); expect(repaired.stdout).toContain("duplicates=1"); expect(repaired.stdout).toContain("errors=0");
    safeDiagnostics(repaired, source); const final = state(o.vault); expect(final.sources).toEqual(initial.sources); expect(final.events).toHaveLength(2); expect(final.events.every(event => event.deleted === 0)).toBe(true);
    expect(final.events.filter(event => event.event_id === initial.events[0]!.event_id)).toEqual(initial.events);
    expect(new Set(final.events.map(event => event.source_record_id)).size).toBe(2);
    const repairedCursor = final.runs.at(-1)!.committed_cursor;
    expect(repairedCursor).not.toBe(partialCursor);
    expectSnapshotCursor(repairedCursor, connector, repairedSource, 2, true);
    expect(final.runs.at(-1)).toMatchObject({ status: "ok", previous_cursor: partialCursor, stored: 1, duplicates: 1, errors: "[]" });
    expect(final.checkpoints).toEqual([{ cursor: repairedCursor, backfill_cursor: repairedCursor, backfill_complete: 1 }]);
    const cleanRepeat = h.runCli(o.env, "import", connector, "--source", source);
    expect(cleanRepeat.exitCode).toBe(0); expect(cleanRepeat.stdout).toContain("events_stored=0"); expect(cleanRepeat.stdout).toContain("duplicates=0"); expect(cleanRepeat.stdout).toContain("errors=0"); safeDiagnostics(cleanRepeat, source);
    const unchanged = state(o.vault);
    expect(unchanged.events).toEqual(final.events); expect(unchanged.sources).toEqual(final.sources); expect(unchanged.checkpoints).toEqual(final.checkpoints);
    expect(unchanged.runs.at(-1)).toMatchObject({ status: "ok", previous_cursor: repairedCursor, committed_cursor: repairedCursor, stored: 0, duplicates: 0, errors: "[]" });
    expect(readFileSync(source, "utf8")).toBe(repairedSource);
  });

  test(`${connector} initially all-malformed export never commits a completion cursor`, () => {
    const o = h.tempVault(), source = join(o.root, "synthetic-invalid.json"); writeFileSync(source, JSON.stringify([BAD, null, 7]));
    const result = h.runCli(o.env, "import", connector, "--source", source, ...fixtureConsent(o.root));
    expect(result.exitCode).toBe(1); expect(result.stdout).toContain("events_stored=0"); expect(result.stderr).toContain("partial_import: 3 record errors (not_object=3)");
    safeDiagnostics(result, source); const actual = state(o.vault); expect(actual.events).toEqual([]); expect(actual.runs).toHaveLength(1);
    expect(actual.runs[0]).toMatchObject({ status: "unavailable", committed_cursor: null });
  });
}

test("all-valid ChatGPT export imports every message and repeats without duplicate revisions", () => {
  const o = h.tempVault(), source = join(o.root, "synthetic-valid.json"); writeFileSync(source, JSON.stringify([conversation("one"), conversation("two")]));
  const first = h.runCli(o.env, "import", "import-chatgpt", "--source", source, ...fixtureConsent(o.root));
  expect(first.exitCode, first.stderr).toBe(0); expect(first.stdout).toContain("events_stored=2"); expect(first.stdout).toContain("errors=0");
  const repeat = h.runCli(o.env, "import", "import-chatgpt", "--source", source); expect(repeat.exitCode).toBe(0); expect(repeat.stdout).toContain("events_stored=0"); expect(repeat.stdout).toContain("duplicates=0");
  expect(state(o.vault).events).toHaveLength(2); safeDiagnostics(first, source); safeDiagnostics(repeat, source);
});
