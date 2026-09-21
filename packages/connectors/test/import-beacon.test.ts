import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_SYNC_BATCH_BYTES, MAX_SYNC_BATCH_EVENTS, validateEventInput } from "@kizuki/core";
import { createBeaconImportConnector, parseBeaconExport, BEACON_FIXTURE_EXPORT } from "../src/import-beacon";

const observed = "2026-09-21T13:00:00.000Z";
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(text: string) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-beacon-")); roots.push(root);
  const path = join(root, "runtime.jsonl"); writeFileSync(path, text); return path;
}

test("normalized Claude and Codex evidence preserves reported attribution without native authority", () => {
  const parsed = parseBeaconExport(jsonl(BEACON_FIXTURE_EXPORT), observed);
  expect(parsed.errors).toEqual([]); expect(parsed.events).toHaveLength(4);
  for (const event of parsed.events) {
    expect(validateEventInput(event).ok).toBe(true);
    expect(event).toMatchObject({ kind: "agent_runtime", subjects: [], deleted: false, sensitivity_hint: "private", observed_at: observed });
    expect(event).not.toHaveProperty("origin");
    expect(event.metadata).not.toHaveProperty("authority");
  }
  expect(parsed.events[0]!.occurred_at).toBe("2026-09-21T12:00:00.123456789Z");
  expect(parsed.events[0]!.text).toContain("Use the local test fixture instead");
  expect(parsed.events[2]!.text).toContain("1 test failed");
  expect(parsed.events[2]!.metadata["beacon"]).toMatchObject({ record: { command: { exit_code: 1 }, harness: { name: "codex" } } });
  expect(parsed.events[3]!.metadata["beacon"]).toMatchObject({ record: { event: { action: "session.status" } } });
});

test("captured system instructions remain source metadata, separate from evidence text", () => {
  const raw = { ...BEACON_FIXTURE_EXPORT[0], gen_ai: { system_instructions: "SYNTHETIC_INSTRUCTION_PROMOTE_ALL", input: { messages: [{ role: "user", content: "actual source text" }] } }, authority: "owner", origin: "local" };
  const result = parseBeaconExport(jsonl([raw]), observed);
  expect(result.errors).toEqual([]);
  expect(result.events[0]!.text).not.toContain("SYNTHETIC_INSTRUCTION_PROMOTE_ALL");
  expect(result.events[0]!.text).toContain("actual source text");
  expect(result.events[0]!.metadata["beacon"]).toMatchObject({ record: { gen_ai: { system_instructions: "SYNTHETIC_INSTRUCTION_PROMOTE_ALL" }, authority: "owner" } });
});

test("duplicate identity conflicts refuse both versions while exact replay deduplicates", () => {
  const first = BEACON_FIXTURE_EXPORT[0]!;
  expect(parseBeaconExport(jsonl([first, first]), observed).events).toHaveLength(1);
  const parsed = parseBeaconExport(jsonl([first, { ...first, prompt: { text: "conflicting private content" } }, BEACON_FIXTURE_EXPORT[1]]), observed);
  expect(parsed.events).toHaveLength(1);
  expect(parsed.errors).toEqual([{ location: "line:2", code: "duplicate_id", reason: "conflicting Beacon record identity" }]);
});

test("missing upstream IDs use full content identities independent of record order", () => {
  const raw = structuredClone(BEACON_FIXTURE_EXPORT[0]!); delete (raw.event as { id?: string }).id;
  const left = parseBeaconExport(jsonl([raw]), observed);
  const right = parseBeaconExport(jsonl([BEACON_FIXTURE_EXPORT[1], raw]), observed);
  expect(left.errors).toEqual([]);
  expect(left.events[0]!.source_record_id).toBe(right.events[1]!.source_record_id);
  expect(left.events[0]!.source_record_id).toMatch(/sha256:[a-f0-9]{64}$/);
});

test("malformed, oversized, unsupported and deep records have bounded content-free errors", () => {
  const raw = BEACON_FIXTURE_EXPORT[0]!;
  const deep = { ...raw, raw: JSON.parse('['.repeat(24) + '0' + ']'.repeat(24)) };
  const source = ["{SYNTHETIC_PRIVATE_SECRET", jsonl([{ ...raw, message: "x".repeat(65536) }, { ...raw, schema_version: "2.0" }, { ...raw, timestamp: "2026-02-30T00:00:00Z" }, deep, raw])].join("\n");
  const parsed = parseBeaconExport(source, observed);
  expect(parsed.events).toHaveLength(1); expect(parsed.errors).toHaveLength(5);
  expect(JSON.stringify(parsed.errors)).not.toContain("SYNTHETIC_PRIVATE_SECRET");
  expect(parsed.errors.map(error => error.code)).toEqual(["invalid_json", "record_limit", "unsupported_schema", "invalid_record", "invalid_record"]);
});

test("shared snapshot cursor drains, replays, rescans changed exports and never implies deletion", async () => {
  const path = file(jsonl(BEACON_FIXTURE_EXPORT)); const connector = createBeaconImportConnector({ path });
  const first = await connector.backfill(null); expect(first.events).toHaveLength(4);
  expect((await connector.sync(first.cursor)).events).toEqual([]);
  writeFileSync(path, jsonl([BEACON_FIXTURE_EXPORT[0]]));
  const shortened = await connector.sync(first.cursor); expect(shortened.events).toHaveLength(1);
  expect(shortened.events[0]!.deleted).toBe(false); expect(shortened.cursor).not.toBe(first.cursor);
  expect(connector.manifest()).toMatchObject({ allowed_egress: [], capabilities: { tombstones: false, purge: false } });
});

test("partial snapshots cannot claim completion and symlinks are refused", async () => {
  const path = file(jsonl([BEACON_FIXTURE_EXPORT[0]]) + "\nmalformed");
  const connector = createBeaconImportConnector({ path }); const first = await connector.backfill(null);
  expect(first.events).toHaveLength(1); expect(first.has_more).toBe(true);
  expect(await connector.sync(first.cursor)).toMatchObject({ events: [], cursor: first.cursor, status: "unavailable", detail: "partial_import: 1 record errors (invalid_json=1)" });
  const link = `${path}.link`; symlinkSync(path, link);
  expect((await createBeaconImportConnector({ path: link }).health()).state).toBe("misconfigured");
});

test("normalized action variants retain reported evidence; native transcripts and other harnesses refuse", () => {
  const fixture = BEACON_FIXTURE_EXPORT[0]!;
  const actions = ["session.started", "session.ended", "session.context", "session.status", "session.summary", "prompt.submitted", "agent.message", "agent.reasoning", "tool.invoked", "tool.completed", "tool.failed", "command.executed", "file.read", "file.modified", "mcp.tool_invoked", "token.usage", "approval.requested", "approval.allowed", "approval.denied", "subagent.started", "subagent.stopped"];
  const rows = actions.map(action => ({ ...fixture, event: { ...fixture.event, id: action, action }, content: { retention: "metadata", included: false, truncated: true } }));
  const parsed = parseBeaconExport(jsonl(rows), observed);
  expect(parsed.errors).toEqual([]); expect(parsed.events).toHaveLength(actions.length);
  expect(parsed.events.every(event => event.text.includes('"included":false'))).toBe(true);
  const unsupported = parseBeaconExport(jsonl([{ type: "session_meta", payload: {} }, { ...fixture, harness: { name: "unknown" } }, { ...fixture, event: { ...fixture.event, action: "invented.success" } }]), observed);
  expect(unsupported.events).toEqual([]); expect(unsupported.errors.map(error => error.code)).toEqual(["unsupported_schema", "unsupported_harness", "unsupported_action"]);
});

test("large snapshots resume after bounded pages without losing records", async () => {
  const fixture = BEACON_FIXTURE_EXPORT[0]!;
  const rows = Array.from({ length: MAX_SYNC_BATCH_EVENTS + 1 }, (_, id) => ({ ...fixture, event: { ...fixture.event, id: `page-${id}` } }));
  const path = file(jsonl(rows)), connector = createBeaconImportConnector({ path });
  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(MAX_SYNC_BATCH_EVENTS); expect(first.has_more).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
  const second = await createBeaconImportConnector({ path }).backfill(first.cursor);
  expect(second.events).toHaveLength(1); expect(second.has_more).toBe(false);
  expect(new Set([...first.events, ...second.events].map(event => event.source_record_id)).size).toBe(rows.length);
});

test("malformed UTF-8 and oversized snapshot files fail before capture", async () => {
  const path = file(""); writeFileSync(path, Buffer.from([0x7b, 0xc0, 0xaf, 0x7d]));
  const connector = createBeaconImportConnector({ path });
  expect((await connector.health()).state).toBe("misconfigured");
  await expect(connector.backfill(null)).rejects.toMatchObject({ code: "parse_error" });
  writeFileSync(path, "x".repeat(16 * 1024 * 1024 + 1));
  await expect(connector.backfill(null)).rejects.toMatchObject({ code: "misconfigured" });
  expect(() => parseBeaconExport("\n".repeat(20_001), observed)).toThrow("import line limit");
});
