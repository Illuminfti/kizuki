import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const h = createHelpers(); afterEach(h.cleanup);
const BODY = "SYNTHETIC_PRIVATE_MARKDOWN_BODY\n";
const NAME = "SYNTHETIC_PRIVATE_FILENAME.md";
const INVALID = Buffer.from([255, 254, 253]);

function fixture() {
  const o = h.tempVault(), source = join(o.root, "synthetic-import-notes");
  mkdirSync(source);
  const policy = join(o.root, "source-policy.json");
  writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "session", "derive", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
    egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });
  const consent = ["--policy", policy, "--expected-revision", "0", "--operation-id", "synthetic-markdown-invalid-grant"];
  return { ...o, source, consent };
}

function state(vault: string) {
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try { return {
    sources: db.query<{ source_key: string; disconnected_at: string | null }, []>("SELECT source_key, disconnected_at FROM connections").all(),
    events: db.query<{ source_record_id: string; deleted: number }, []>("SELECT source_record_id,deleted FROM events ORDER BY event_id").all(),
    runs: db.query<{ status: string; committed_cursor: string | null; errors: string }, []>("SELECT status,committed_cursor,errors FROM connection_runs ORDER BY rowid").all(),
  }; } finally { db.close(); }
}

function safeDiagnostics(result: { stdout: string; stderr: string }, source: string) {
  for (const forbidden of [BODY.trim(), NAME, source]) expect(result.stdout + result.stderr).not.toContain(forbidden);
}

test("Markdown import keeps valid evidence and visibly refuses malformed bytes until corrected", () => {
  const o = fixture(), invalid = join(o.source, NAME);
  writeFileSync(join(o.source, "valid.md"), BODY); writeFileSync(invalid, INVALID);
  const first = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(first.exitCode).toBe(1); expect(first.stdout).toContain("events_stored=1"); expect(first.stdout).toContain("errors=1");
  expect(first.stderr).toContain("partial_import: 1 record errors (not_utf8=1)"); safeDiagnostics(first, o.source);
  expect(readFileSync(invalid)).toEqual(INVALID);
  const initial = state(o.vault);
  expect(initial.sources).toHaveLength(1); expect(initial.sources[0]!.disconnected_at).toBeNull();
  expect(initial.events).toEqual([{ source_record_id: "valid.md", deleted: 0 }]);
  expect(initial.runs.map(run => run.status)).toEqual(["ok", "unavailable"]);
  expect(initial.runs[1]!.committed_cursor).toBe(initial.runs[0]!.committed_cursor);
  expect(JSON.parse(initial.runs[1]!.errors)).toEqual(["partial_import: 1 record errors (not_utf8=1)"]);
  const repeat = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(repeat.exitCode).toBe(1); expect(repeat.stdout).toContain("events_stored=0"); expect(repeat.stdout).toContain("duplicates=0");
  expect(repeat.stderr).toContain("not_utf8=1"); safeDiagnostics(repeat, o.source);
  expect(state(o.vault).events).toEqual(initial.events);
  expect(state(o.vault).runs.at(-1)).toMatchObject({ status: "unavailable", committed_cursor: initial.runs[0]!.committed_cursor });
  writeFileSync(invalid, "SYNTHETIC_REPAIRED_ONCE\n");
  const repaired = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(repaired.exitCode, repaired.stderr).toBe(0); expect(repaired.stdout).toContain("events_stored=1");
  expect(repaired.stdout).toContain("duplicates=0"); expect(repaired.stdout).toContain("errors=0"); safeDiagnostics(repaired, o.source);
  const after = state(o.vault); expect(after.sources.map(source => source.source_key)).toEqual(initial.sources.map(source => source.source_key));
  expect(after.sources[0]!.disconnected_at).toBeNull();
  expect(after.events).toHaveLength(2);
  expect(after.events.every(event => event.deleted === 0)).toBe(true);
  const cleanRepeat = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(cleanRepeat.exitCode).toBe(0); expect(cleanRepeat.stdout).toContain("events_stored=0"); expect(cleanRepeat.stdout).toContain("duplicates=0");
});

test("all-malformed Markdown import never commits a completion checkpoint or hides repeat failure", () => {
  const o = fixture(); writeFileSync(join(o.source, NAME), INVALID);
  const first = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(first.exitCode).toBe(1); expect(first.stdout).toContain("events_stored=0"); expect(first.stdout).toContain("errors=1");
  expect(first.stderr).toContain("not_utf8=1"); expect(first.stderr).toContain("connection was not left active");
  safeDiagnostics(first, o.source);
  const initial = state(o.vault); expect(initial.events).toEqual([]);
  expect(initial.sources).toHaveLength(1); expect(initial.sources[0]!.disconnected_at).not.toBeNull();
  expect(initial.runs).toHaveLength(1); expect(initial.runs[0]).toMatchObject({ status: "unavailable", committed_cursor: null });
  const repeat = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(repeat.exitCode).toBe(1); expect(repeat.stdout).toContain("events_stored=0"); expect(repeat.stderr).toContain("not_utf8=1");
  expect(repeat.stderr).toContain("connection was not left active");
  safeDiagnostics(repeat, o.source); expect(state(o.vault).runs.at(-1)).toMatchObject({ status: "unavailable", committed_cursor: null });
  expect(state(o.vault).sources[0]!.disconnected_at).not.toBeNull();
});
