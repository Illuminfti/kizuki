import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CURSOR_BYTES, getCheckpoint, inspectSourceGrant, registerConnection, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { MARKDOWN_FOLDER_CONNECTOR_ID, MAX_FILES } from "@kizuki/connectors";
import { markdownCommittedIdentities } from "../src/connections";
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

test("Markdown import preserves nested Unicode frontmatter and records later edits and deletions", () => {
  const o = fixture();
  const nested = join(o.source, "journal", "café");
  mkdirSync(nested, { recursive: true });
  const note = join(nested, "note.md");
  const body = [
    "---",
    "title: synthetic-frontmatter",
    "tags: [ada, café]",
    "---",
    "",
    "SYNTHETIC_NESTED_UNICODE 日本語\n",
  ].join("\n");
  writeFileSync(join(o.source, "root.markdown"), "SYNTHETIC_MARKDOWN_EXT\n");
  writeFileSync(note, body);
  const first = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.stdout).toContain("events_stored=2");
  expect(first.stdout).toContain("errors=0");
  safeDiagnostics(first, o.source);
  expect(state(o.vault).events.map((event) => event.source_record_id).sort()).toEqual([
    "journal/café/note.md",
    "root.markdown",
  ]);
  const repeat = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(repeat.exitCode).toBe(0);
  expect(repeat.stdout).toContain("events_stored=0");
  expect(repeat.stdout).toContain("duplicates=0");
  writeFileSync(note, `${body}edited\n`);
  const edited = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(edited.exitCode, edited.stderr).toBe(0);
  expect(edited.stdout).toContain("events_stored=1");
  expect(edited.stdout).toContain("duplicates=0");
  unlinkSync(note);
  const removed = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect(removed.stdout).toContain("events_stored=1");
  const after = state(o.vault);
  expect(after.events.filter((event) => event.source_record_id === "journal/café/note.md").at(-1)).toEqual({
    source_record_id: "journal/café/note.md",
    deleted: 1,
  });
  expect(after.events.some((event) => event.source_record_id === "root.markdown" && event.deleted === 0)).toBe(true);
});

test("Markdown import skips a symlink and a bounded oversize file without dropping the sibling", () => {
  const o = fixture();
  const outside = join(o.root, "outside.md");
  writeFileSync(outside, "SYNTHETIC_OUTSIDE_TARGET\n");
  writeFileSync(join(o.source, "own.md"), BODY);
  symlinkSync(outside, join(o.source, "link.md"));
  writeFileSync(join(o.source, "huge.md"), Buffer.alloc(1_048_577, 0x61));
  const first = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toContain("events_stored=1");
  expect(first.stderr).toContain("too_large");
  expect(first.stderr).toContain("symlink");
  safeDiagnostics(first, o.source);
  expect(state(o.vault).events).toEqual([{ source_record_id: "own.md", deleted: 0 }]);
});

test("native Markdown import stores unique files behind a compact cursor and path-only state", () => {
  const o = fixture();
  writeFileSync(join(o.source, "alpha.md"), "SYNTHETIC_ALPHA\n");
  writeFileSync(join(o.source, "beta.md"), "SYNTHETIC_BETA\n");
  const first = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(first.stdout).toContain("events_stored=2");
  const db = openLedger(join(o.vault, ".kizuki/kizuki.db"));
  try {
    const source = db.query<{ source_key: string }, []>("SELECT source_key FROM connections").get()!.source_key;
    const checkpoint = getCheckpoint(db, MARKDOWN_FOLDER_CONNECTOR_ID, source);
    const cursor = checkpoint?.backfill_cursor;
    expect(cursor).toEqual(expect.any(String));
    expect(new TextEncoder().encode(cursor!).byteLength).toBeLessThanOrEqual(MAX_CURSOR_BYTES);
    expect(JSON.parse(cursor!)).toMatchObject({ committed_identities: true, exhausted: true });
    expect(JSON.parse(cursor!)).not.toHaveProperty("files");
    expect(JSON.parse(cursor!)).not.toHaveProperty("pack");
    const identities = markdownCommittedIdentities(db, source);
    expect(identities.map(([relpath]) => relpath).sort()).toEqual(["alpha.md", "beta.md"]);
    expect(JSON.stringify(identities)).not.toContain("SYNTHETIC_ALPHA");
    const statePath = join(o.vault, ".kizuki/connections", `${source}.state`);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      schema: "kizuki.cli.connection-state/v1",
      connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
      config: { path: o.source },
    });
  } finally { db.close(); }
  const repeat = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source);
  expect(repeat.exitCode, repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("events_stored=0");
  expect(repeat.stdout).toContain("duplicates=0");
});

test("portable restore reconstructs Markdown identities from the ledger and path-only state", () => {
  const o = fixture();
  writeFileSync(join(o.source, "kept.md"), "kept-before\n");
  writeFileSync(join(o.source, "removed.md"), "removed\n");
  const imported = h.runCli(o.env, "import", "kizuki.markdown-folder", "--source", o.source, ...o.consent);
  expect(imported.exitCode, imported.stderr).toBe(0);
  const backup = join(o.root, "snapshot");
  const into = join(o.root, "restored");
  expect(h.runCli(o.env, "export", "--out", backup).exitCode).toBe(0);
  const relative = "connections/portable-local.v1.jsonl";
  const portable = readFileSync(join(backup, relative), "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    connector_id: string;
    path: string;
    source_key: string;
  });
  expect(portable).toEqual([
    expect.objectContaining({
      connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
      path: o.source,
    }),
  ]);
  expect(JSON.stringify(portable)).not.toContain("sha256");
  expect(h.runCli(o.env, "restore", "--from", backup, "--into", into).exitCode).toBe(0);
  writeFileSync(join(o.source, "kept.md"), "kept-after\n");
  unlinkSync(join(o.source, "removed.md"));
  const synced = h.runCli({ ...o.env, KIZUKI_VAULT: into }, "sync", "markdown-folder");
  expect(synced.exitCode, synced.stderr).toBe(0);
  expect(synced.stdout).toContain("events_stored=2");
  const db = openLedger(join(into, ".kizuki/kizuki.db"));
  try {
    const source = db.query<{ source_key: string }, []>("SELECT source_key FROM connections").get()!.source_key;
    expect(markdownCommittedIdentities(db, source).map(([relpath]) => relpath)).toEqual(["kept.md"]);
    const statePath = join(into, ".kizuki/connections", `${source}.state`);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      schema: "kizuki.cli.connection-state/v1",
      connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
      config: { path: o.source },
    });
    expect(readdirSync(join(into, ".kizuki/connections")).every((name) => !name.includes("inventory"))).toBe(true);
  } finally { db.close(); }
});

test("a 50k-row identity query returns latest live metadata without event text", () => {
  const db = openLedger(":memory:");
  const sourceA = "01JJ000000000000000000002A";
  const sourceB = "01JJ000000000000000000002B";
  try {
    registerConnection(db, MARKDOWN_FOLDER_CONNECTOR_ID, sourceA);
    registerConnection(db, MARKDOWN_FOLDER_CONNECTOR_ID, sourceB);
    setSourceGrant(db, {
      source_key: sourceA, expected_revision: 0, operation_id: "synthetic-markdown-50k-a",
      policy: { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" },
    });
    setSourceGrant(db, {
      source_key: sourceB, expected_revision: 0, operation_id: "synthetic-markdown-50k-b",
      policy: { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" },
    });
    const grantA = inspectSourceGrant(db, sourceA)!;
    const grantB = inspectSourceGrant(db, sourceB)!;
    const hex = (value: number) => value.toString(16).padStart(64, "0");
    const ulid = (prefix: string, value: number) => `${prefix}${String(value).padStart(24, "0")}`;
    const stamp = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
    const insert = db.query(
      `INSERT INTO events (
         event_id, connector_id, source_record_id, kind, occurred_at, observed_at, text, subjects,
         sensitivity_hint, deleted, attachments, metadata, content_hash, accepted_at,
         content_hash_version, text_hash, origin, origin_binding_version, origin_binding_kind, origin_binding
       ) VALUES (?, ?, ?, 'file', ?, ?, ?, '[]', NULL, ?, '[]', ?, ?, ?, 2, ?, 'external', 1, 'capture', ?)`,
    );
    const bind = db.query("INSERT INTO source_event_bindings VALUES (?, ?, ?, ?)");
    const canary = "SECRET_TEXT_MUST_NOT_LEAK";
    db.transaction(() => {
      for (let index = 0; index < MAX_FILES; index += 1) {
        const eventId = ulid("01", index);
        const relpath = `n-${String(index).padStart(5, "0")}.md`;
        insert.run(
          eventId, MARKDOWN_FOLDER_CONNECTOR_ID, relpath, stamp, stamp, canary, 0,
          JSON.stringify({ relpath, sha256: hex(index + 1), size: index }), hex(index + 1), stamp,
          hex(index + 2), hex(index + 3),
        );
        bind.run(eventId, sourceA, grantA.revision, grantA.policy_digest);
      }
      insert.run(
        ulid("02", 0), MARKDOWN_FOLDER_CONNECTOR_ID, "n-00000.md", later, later, canary, 0,
        JSON.stringify({ relpath: "n-00000.md", sha256: hex(99), size: 7 }), hex(90), later,
        hex(91), hex(92),
      );
      bind.run(ulid("02", 0), sourceA, grantA.revision, grantA.policy_digest);
      insert.run(
        ulid("03", 0), MARKDOWN_FOLDER_CONNECTOR_ID, "gone.md", stamp, stamp, canary, 0,
        JSON.stringify({ relpath: "gone.md", sha256: hex(80), size: 3 }), hex(80), stamp,
        hex(81), hex(82),
      );
      bind.run(ulid("03", 0), sourceA, grantA.revision, grantA.policy_digest);
      insert.run(
        ulid("04", 0), MARKDOWN_FOLDER_CONNECTOR_ID, "gone.md", later, later, "", 1,
        JSON.stringify({ relpath: "gone.md", snapshot: "absent" }), hex(83), later,
        hex(84), hex(85),
      );
      bind.run(ulid("04", 0), sourceA, grantA.revision, grantA.policy_digest);
      insert.run(
        ulid("05", 0), MARKDOWN_FOLDER_CONNECTOR_ID, "n-00000.md", stamp, stamp, canary, 0,
        JSON.stringify({ relpath: "n-00000.md", sha256: hex(70), size: 11 }), hex(70), stamp,
        hex(71), hex(72),
      );
      bind.run(ulid("05", 0), sourceB, grantB.revision, grantB.policy_digest);
    })();
    const identities = markdownCommittedIdentities(db, sourceA);
    expect(identities).toHaveLength(MAX_FILES);
    expect(identities.find(([relpath]) => relpath === "n-00000.md")).toEqual([
      "n-00000.md", { sha256: hex(99), size: 7 },
    ]);
    expect(identities.some(([relpath]) => relpath === "gone.md")).toBe(false);
    expect(JSON.stringify(identities)).not.toContain(canary);
    expect(markdownCommittedIdentities(db, sourceB)).toEqual([
      ["n-00000.md", { sha256: hex(70), size: 11 }],
    ]);
  } finally { db.close(); }
});
