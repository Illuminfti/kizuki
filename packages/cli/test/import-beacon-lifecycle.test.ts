import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSince } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { BEACON_FIXTURE_EXPORT } from "../../connectors/src/import-beacon";
import { createHelpers, fixtureConsent } from "./helpers";

const h = createHelpers(); afterEach(h.cleanup);
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
function state(vault: string) {
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try { return {
    events: readSince(db, null, 100).events,
    sources: db.query<{ source_key: string }, []>("SELECT source_key FROM connections WHERE connector_id='kizuki.import-beacon'").all(),
    bindings: db.query<{ event_id: string; source_key: string }, []>("SELECT event_id,source_key FROM source_event_bindings ORDER BY event_id").all(),
    runs: db.query<{ status: string; committed_cursor: string | null }, []>("SELECT status,committed_cursor FROM connection_runs ORDER BY rowid").all(),
    native: db.query<{ count: number }, []>("SELECT count(*) count FROM native_owner_evidence").get()!.count,
    eventRows: db.query<{ count: number }, []>("SELECT count(*) count FROM events").get()!.count,
  }; } finally { db.close(); }
}
function setup(rows: unknown[] = BEACON_FIXTURE_EXPORT) {
  const o = h.tempVault(), source = join(o.root, "runtime.jsonl");
  writeFileSync(source, jsonl(rows));
  return { ...o, source };
}

test("public Beacon import captures nested evidence, replays and keeps changed records as revisions", () => {
  const o = setup([...BEACON_FIXTURE_EXPORT].reverse());
  const first = h.runCli(o.env, "import", "beacon", "--source", o.source, ...fixtureConsent(o.root));
  expect(first.exitCode, first.stderr).toBe(0); expect(first.stdout).toContain("events_stored=4");
  const before = state(o.vault); expect(before.events).toHaveLength(4); expect(before.native).toBe(0);
  expect(before.events.map(event => ((event.metadata["beacon"] as { record: { sequence: number } }).record.sequence))).toEqual([1, 2, 3, 4]);
  expect(before.bindings).toHaveLength(4); expect(new Set(before.bindings.map(row => row.source_key))).toEqual(new Set([before.sources[0]!.source_key]));
  expect(before.events.every(event => event.origin_binding_kind === "capture")).toBe(true);
  expect(before.events.find(event => event.text.includes("1 test failed"))!.metadata["beacon"]).toMatchObject({ record: { command: { exit_code: 1 } } });
  const recalled = h.runCli(o.env, "query", "hosted");
  expect(recalled.exitCode, recalled.stderr).toBe(0); expect(recalled.stdout).toContain("Use the local test fixture instead");
  const repeat = h.runCli(o.env, "import", "import-beacon", "--source", o.source);
  expect(repeat.exitCode, repeat.stderr).toBe(0); expect(repeat.stdout).toContain("events_stored=0");
  // A changed snapshot rescans; the same immutable evidence is still replay.
  writeFileSync(o.source, jsonl(BEACON_FIXTURE_EXPORT));
  const reordered = h.runCli(o.env, "import", "beacon", "--source", o.source);
  expect(reordered.exitCode, reordered.stderr).toBe(0); expect(reordered.stdout).toContain("duplicates=4");
  const changed = { ...BEACON_FIXTURE_EXPORT[0], prompt: { text: "Actually preserve the original failing test." } };
  writeFileSync(o.source, jsonl([changed, ...BEACON_FIXTURE_EXPORT.slice(1)]));
  const revised = h.runCli(o.env, "import", "beacon", "--source", o.source);
  expect(revised.exitCode, revised.stderr).toBe(0); expect(revised.stdout).toContain("events_stored=1"); expect(revised.stdout).toContain("duplicates=3");
  const after = state(o.vault); expect(after.events).toHaveLength(5); expect(after.native).toBe(0);
  const original = before.events.find(event => event.text.includes("Use the local test fixture instead"))!;
  const revisions = after.events.filter(event => event.source_record_id === original.source_record_id);
  expect(revisions).toHaveLength(2); expect(new Set(revisions.map(event => event.content_hash)).size).toBe(2);
  expect(new Set(after.bindings.map(row => row.source_key))).toEqual(new Set([before.sources[0]!.source_key]));
});

test("capture is denied without source consent and foreign enrollment cannot take an existing event", () => {
  const o = setup([BEACON_FIXTURE_EXPORT[0]]);
  const denied = h.runCli(o.env, "import", "beacon", "--source", o.source);
  expect(denied.exitCode).toBe(1); expect(denied.stderr).toContain("source_capture_denied"); expect(state(o.vault).events).toEqual([]);
  expect(h.runCli(o.env, "import", "beacon", "--source", o.source, ...fixtureConsent(o.root)).exitCode).toBe(0);
  const before = state(o.vault), foreign = join(o.root, "foreign.jsonl"); writeFileSync(foreign, readFileSync(o.source));
  const result = h.runCli(o.env, "import", "beacon", "--source", foreign, ...fixtureConsent(o.root, "foreign-grant"));
  expect(result.exitCode).toBe(1); expect(result.stderr).toContain("source_binding_conflict");
  expect(state(o.vault).events).toEqual(before.events); expect(state(o.vault).bindings).toEqual(before.bindings);
});

test("CLI reports malformed and oversized records without printing source content or completing the cursor", () => {
  const o = setup([BEACON_FIXTURE_EXPORT[0], { ...BEACON_FIXTURE_EXPORT[1], message: "x".repeat(65536) }]);
  writeFileSync(o.source, readFileSync(o.source, "utf8") + "\n{PRIVATE_BROKEN_RECORD");
  const first = h.runCli(o.env, "import", "beacon", "--source", o.source, ...fixtureConsent(o.root));
  expect(first.exitCode).toBe(1); expect(first.stdout).toContain("events_stored=1");
  expect(first.stderr).toContain("partial_import: 2 record errors (invalid_json=1 record_limit=1)");
  for (const secret of ["PRIVATE_BROKEN_RECORD", "Use the local test fixture instead", o.source]) expect(first.stdout + first.stderr).not.toContain(secret);
  const captured = state(o.vault); expect(captured.events).toHaveLength(1);
  expect(JSON.parse(captured.runs.at(-1)!.committed_cursor!).exhausted).toBe(false);
  const repeat = h.runCli(o.env, "import", "beacon", "--source", o.source);
  expect(repeat.exitCode).toBe(1); expect(repeat.stdout).toContain("events_stored=0");
  expect(state(o.vault).events).toEqual(captured.events);
});

test("source revocation purges imported run evidence and blocks rereads while leaving the selected export alone", () => {
  const o = setup(); const original = readFileSync(o.source, "utf8");
  expect(h.runCli(o.env, "import", "beacon", "--source", o.source, ...fixtureConsent(o.root)).exitCode).toBe(0);
  const before = state(o.vault), sourceKey = before.sources[0]!.source_key;
  const revoked = h.runCli(o.env, "connect", "revoke", "--source", sourceKey, "--expected-revision", "1", "--operation-id", "beacon-revoke", "--json");
  expect(revoked.exitCode, revoked.stderr + revoked.stdout).toBe(0);
  const purged = h.runCli(o.env, "connect", "resume-revocation", "--source", sourceKey, "--operation-id", "beacon-revoke", "--json");
  expect(purged.exitCode, purged.stderr + purged.stdout).toBe(0);
  expect(JSON.parse(purged.stdout).data.purge).toBe("complete");
  const after = state(o.vault);
  expect(after.events).toEqual([]); expect(after.eventRows).toBe(0);
  // Source purge deliberately retains these content-free receipt bindings.
  expect(after.bindings).toEqual(before.bindings);
  const denied = h.runCli(o.env, "import", "beacon", "--source", o.source);
  expect(denied.exitCode).toBe(1); expect(denied.stderr).toContain("source_capture_denied");
  expect(readFileSync(o.source, "utf8")).toBe(original);
  expect(h.runCli(o.env, "query", "fixture").stdout).not.toContain("Use the local test fixture instead");
}, 15_000);

test("Beacon enrollment, source binding and replay cursor survive public export and restore", () => {
  const o = setup();
  expect(h.runCli(o.env, "import", "beacon", "--source", o.source, ...fixtureConsent(o.root)).exitCode).toBe(0);
  const before = state(o.vault), backup = join(o.root, "backup"), restored = join(o.root, "restored");
  const exported = h.runCli(o.env, "export", "--out", backup);
  expect(exported.exitCode, exported.stderr).toBe(0);
  const result = h.runCli(o.env, "restore", "--from", backup, "--into", restored);
  expect(result.exitCode, result.stderr).toBe(0);
  const after = state(restored); expect(after.events).toEqual(before.events); expect(after.bindings).toEqual(before.bindings);
  expect(after.sources).toEqual(before.sources);
  const replay = h.runCli(o.env, "import", "beacon", "--source", o.source, "--vault", restored);
  expect(replay.exitCode, replay.stderr).toBe(0); expect(replay.stdout).toContain("events_stored=0");
  expect(state(restored).events).toEqual(before.events);
}, 15_000);
