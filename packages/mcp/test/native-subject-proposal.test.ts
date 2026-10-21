import { afterEach, expect, test } from "bun:test";
import { accept, addAgent, authenticate, OWNER_AGENT_GRANT, servePropose, setGrant } from "@kizuki/core";
import { EVENT_LIMITS } from "../../core/src/contracts/event";
import { rawSubjectRefKey } from "../../core/src/contracts/claim-v2";
import { canonicalJson, sha256Hex } from "../../core/src/util/hash";
import type { QuotedChunkV2 } from "../../core/src/contracts/scoped-tools";
import { indexEvent } from "../../core/src/search/index";
import { validEvent } from "../../core/test/fixtures";
import { enrollSource } from "../../core/test/helpers/world-seed";
import { call, connectClient, envelopeOf, errorOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

let fixture: McpFixture | undefined;
const open: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of open.splice(0)) await stop(); fixture?.dispose(); fixture = undefined; });

async function setup() {
  const f = fixture = mcpFixture(), source = enrollSource(f.db, "native.subject", "public");
  // The authoritative event contract is byte-bounded; UTF-8 and printable
  // source spelling survive the scoped reference without legacy shortening.
  const subject = "文".repeat(341) + "x";
  expect(new TextEncoder().encode(subject).length).toBe(EVENT_LIMITS.subjectIdBytes);
  const stored = accept(f.db, { ...validEvent(), connector_id: "native.subject", source_record_id: "native-subject",
    text: "Synthetic native document status is blocked.", subjects: [{ subject_id: subject, role: "about" }], sensitivity_hint: "public" },
    { source: { source_key: source, expected_revision: 1 } });
  if (stored.status !== "stored") throw new Error("capture not stored");
  indexEvent(f.db, stored.event);
  const ctx = { ...f.owner(), principal: authenticate(f.db, addAgent(f.db, "native-reader", OWNER_AGENT_GRANT).token)! };
  const client = await connectClient(ctx, open);
  const quote = (envelopeOf(await call(client, "timeline", { day: "2026-02-28" })).quoted as QuotedChunkV2[])[0]!;
  expect(quote.subjects).toHaveLength(1);
  const input = { kind: "claim" as const, subject: quote.subjects[0]!, subjects: quote.subjects,
    predicate: "project.status", object: { kind: "literal" as const, value: "blocked" },
    body: "The native document records blocked status.", provenance: [quote.eventVersion] };
  const count = () => f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE producer='agent:native-reader'").get()!.n;
  return { f, ctx, client, subject, quote, input, count, event: stored.event };
}

test("scoped proposals preserve byte-bounded native subjects for explicit and first-subject identity", async () => {
  const { f, client, subject, input } = await setup();
  expect(input.subject.token).toHaveLength(43);
  expect((await call(client, "propose", input)).isError).toBeUndefined();
  const { subject: _explicit, ...implicit } = input;
  expect((await call(client, "propose", { ...implicit, object: { kind: "literal", value: "active" }, body: "The document records active status." })).isError).toBeUndefined();
  const rows = f.db.query<{ subject: string; subjects: string }, []>("SELECT subject,subjects FROM claims WHERE producer='agent:native-reader'").all();
  expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row.subject).toBe(subject); expect(JSON.parse(row.subjects)).toEqual([subject]); }
}, 120000);

test("native identity support preserves wire, count, duplicate, legacy and corrupt-authoritative bounds", async () => {
  const { f, ctx, client, subject, input, count, event } = await setup();
  for (const bad of [
    { ...input, subject },
    { ...input, subject: { kind: "raw_subject", token: "a".repeat(44) } },
    { ...input, subjects: Array(17).fill(input.subject) },
    { ...input, subjects: [input.subject, input.subject] },
  ]) expect((await call(client, "propose", bad)).isError).toBe(true);
  await expect(servePropose(ctx, { kind: "claim", subject: "a".repeat(65), subjects: ["a".repeat(65)],
    body: "Legacy bound stays unchanged", provenance: [event.event_id] })).rejects.toMatchObject({ code: "invalid_arguments" });
  const original = f.db.query<{ raw_ref: string; raw_key: string }, [string]>("SELECT raw_ref,raw_key FROM world_wire_raw_subject_targets WHERE wire_ref=?").get(input.subject.token)!;
  const raw = JSON.parse(original.raw_ref);
  // Simulate corrupt derived state. Even a correctly hashed row cannot turn
  // an over-byte-limit or malformed authoritative identifier into permission.
  for (const id of [subject + "x", "bad\nidentifier"]) {
    const corrupt = { ...raw, id };
    f.db.query("UPDATE world_wire_raw_subject_targets SET raw_ref=?,raw_key=? WHERE wire_ref=?").run(canonicalJson(corrupt), sha256Hex(rawSubjectRefKey(corrupt)), input.subject.token);
    expect(errorOf(await call(client, "propose", input)).error).toBe("not_found");
  }
  expect(count()).toBe(0);
}, 120000);

test("native subject refs support exact public search, packet, timeline, graph and correction with live grant denial", async () => {
  const { f, client, input, event } = await setup();
  expect((await call(client, "propose", input)).isError).toBeUndefined();
  const reads: [string, Record<string, unknown>][] = [
    ["search", { query: "Synthetic", scope: "ledger", subjects: input.subjects }],
    ["context_packet", { subjects: input.subjects, include: ["claims"], purpose: "correction", budget_tokens: 500 }],
    ["timeline", { subject: input.subject }],
    ["graph_neighbors", { anchor: input.subject, depth: 1 }],
  ];
  for (const [tool, args] of reads) {
    const result = await call(client, tool, args);
    expect(result.isError).toBeUndefined();
    const envelope = envelopeOf(result);
    if (tool === "search" || tool === "timeline") expect((envelope.quoted as QuotedChunkV2[]).map(row => row.text)).toEqual([event.text]);
    if (tool === "context_packet") expect(JSON.stringify(envelope.data)).toContain("blocked");
    if (tool === "graph_neighbors") expect(envelope.data).toMatchObject({ anchor: input.subject });
  }
  expect((await call(client, "graph_neighbors", { anchor: input.subject, depth: 99 })).isError).toBe(true);
  expect((await call(client, "graph_neighbors", { anchor: input.subject, kinds: ["invented"] })).isError).toBe(true);
  const correction = { statement: "The native document status is active.", target: input.subject, object: { kind: "literal", value: "active" } };
  expect((await call(client, "correct", correction)).isError).toBeUndefined();
  setGrant(f.db, "native-reader", { subjects: [] });
  for (const [tool, args] of [...reads, ["propose", input], ["correct", correction]] as [string, Record<string, unknown>][]) {
    expect(errorOf(await call(client, tool, args)).error).toBe("not_found");
  }
}, 120000);
