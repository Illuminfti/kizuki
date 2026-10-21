import { afterEach, expect, test } from "bun:test";
import { accept, addAgent, authenticate, OWNER_AGENT_GRANT, revokeSourceGrant, setGrant, servePropose } from "@kizuki/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { QuotedChunkV2 } from "../../core/src/contracts/scoped-tools";
import type { ScopedRef } from "../../core/src/contracts/scoped-refs";
import { validEvent } from "../../core/test/fixtures";
import { enrollSource, worldSeed } from "../../core/test/helpers/world-seed";
import { call, connectClient, envelopeOf, errorOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

let fixture: McpFixture | undefined;
const open: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of open.splice(0)) await stop(); fixture?.dispose(); fixture = undefined; });
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } };
const conditions = { task: "verify", attempt: "attempt-1", criterion: "fields present", artifactVersion: "artifact-1",
  environment: "synthetic-v1", result: "met", assistance: "assisted", confounded: false };

async function setup() {
  const f = fixture = mcpFixture();
  const seeded = await worldSeed(f.db, { kind: "procedure", subject: "procedure:verify", label: "Verify delivery", predicates: [], discover: false });
  const actors = [];
  for (const name of ["reporter", "observer", "reviewer"]) {
    const agent = addAgent(f.db, name, OWNER_AGENT_GRANT);
    const ctx = { ...f.owner(), principal: authenticate(f.db, agent.token)! };
    const client = await connectClient(ctx, open);
    const matches = envelopeOf(await call(client, "world_view", { operation: "find_procedures", label: "Verify delivery", ...WHEN })).data as any;
    const subject = matches.result.data.matches[0].ref as ScopedRef<"object">;
    actors.push({ name, ctx, client, subject });
  }
  async function capture(name: string, client: Client, subjects: string[] = []) {
    const source = enrollSource(f.db, name, "public");
    const stored = accept(f.db, { ...validEvent(), connector_id: name, source_record_id: name,
      text: `${name} independently recorded the verification result.`, subjects: subjects.map(subject_id => ({ subject_id, role: "about" })), sensitivity_hint: "public" },
      { source: { source_key: source, expected_revision: 1 } });
    if (stored.status !== "stored") throw new Error("capture not stored");
    const timeline = envelopeOf(await call(client, "timeline", { day: "2026-02-28" }));
    const quote = (timeline.quoted as QuotedChunkV2[]).find(row => row.text === stored.event.text)!;
    expect(quote).toBeDefined();
    return { source, quote };
  }
  const count = () => f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;
  return { f, actors, capture, count, seeded };
}
function input(subject: ScopedRef<"object">, quote: QuotedChunkV2, predicate = "outcome.observation", patch = {}) {
  return { kind: "claim" as const, subject, predicate, object: { kind: "literal" as const,
    value: JSON.stringify({ ...conditions, result: predicate === "outcome.review" ? "accepted" : "met", subjectRef: subject.token, ...patch }) },
    body: `Quoted ${predicate}`, provenance: [quote.eventVersion], confidence: 0.7 };
}

test("scoped MCP outcomes accept independent authorized evidence and require independent matching observation", async () => {
  const { f, actors, capture } = await setup();
  const [reporter, observer, reviewer] = actors as [typeof actors[number], typeof actors[number], typeof actors[number]];
  const evidence = await Promise.all(actors.map(actor => capture(`outcome.${actor.name}`, actor.client)));
  expect(evidence.every(record => record.quote.subjects.length === 0)).toBe(true);
  const read = async () => (envelopeOf(await call(reporter.client, "world_view", {
    operation: "procedure", procedure: reporter.subject, ...WHEN,
  })).data as any).result.data.taskUsefulness;
  expect((await read()).status).toBe("unknown");
  const report = await call(reporter.client, "propose", input(reporter.subject, evidence[0]!.quote, "outcome.self_report"));
  expect(report.isError ?? false).toBe(false);
  expect((envelopeOf(report).data as any).outcome).toBe("stored");
  // The observer resolves the reporter's capture under its own namespace; a
  // second principal quoting the same evidence does not prove independence.
  const timeline = envelopeOf(await call(observer.client, "timeline", { day: "2026-02-28" }));
  const same = (timeline.quoted as QuotedChunkV2[]).find(row => row.text === evidence[0]!.quote.text)!;
  expect((await call(observer.client, "propose", input(observer.subject, same))).isError).toBeUndefined();
  expect((await call(reviewer.client, "propose", input(reviewer.subject, evidence[2]!.quote, "outcome.review"))).isError).toBeUndefined();
  expect((await read()).status).toBe("unknown");
  expect((await call(observer.client, "propose", input(observer.subject, evidence[1]!.quote))).isError).toBeUndefined();
  expect(await read()).toMatchObject({ status: "observed", evaluations: [{ result: "met", goalAchieved: true, independentMastery: false }] });
  const rows = f.db.query<{ provenance: string; object: string }, []>("SELECT provenance, object FROM claims WHERE predicate='outcome.observation'").all();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.object).not.toContain(observer.subject.token);
}, 120000);

test("scoped outcome binding refuses foreign, forged, same-id other-namespace and revoked evidence without filing", async () => {
  const { f, actors, capture, count } = await setup();
  const actor = actors[0]!, peer = actors[1]!;
  const evidence = await capture("outcome.binding", actor.client);
  const before = count();
  const forged = await call(actor.client, "propose", input(actor.subject, evidence.quote, "outcome.observation", { subjectRef: "A".repeat(43) }));
  expect(forged.isError).toBe(true);
  expect((await call(peer.client, "propose", input(peer.subject, evidence.quote))).isError).toBe(true);
  await worldSeed(f.db, { kind: "procedure", subject: "procedure:verify", label: "Other procedure", connector: "other.procedure", predicates: [], discover: false });
  const other = (envelopeOf(await call(actor.client, "world_view", { operation: "find_procedures", label: "Other procedure", ...WHEN })).data as any).result.data.matches[0].ref;
  const otherTimeline = envelopeOf(await call(actor.client, "timeline", { day: "2026-02-28" }));
  const otherEvidence = (otherTimeline.quoted as QuotedChunkV2[]).find(row => row.text.startsWith("Other procedure"))!;
  expect(otherEvidence.subjects).toHaveLength(1);
  const beforeMismatch = count();
  const mismatched = await call(actor.client, "propose", { ...input(actor.subject, otherEvidence, "outcome.observation", { subjectRef: other.token }), subjects: otherEvidence.subjects });
  expect(mismatched.isError).toBe(true);
  expect(count()).toBe(beforeMismatch);
  const { subject: _subject, ...implicit } = input(actor.subject, otherEvidence, "outcome.observation", { subjectRef: other.token });
  const originalTimeline = envelopeOf(await call(actor.client, "timeline", { day: "2026-02-28" }));
  const originalEvidence = (originalTimeline.quoted as QuotedChunkV2[]).find(row => row.text.startsWith("Verify delivery"))!;
  expect((await call(actor.client, "propose", { ...implicit, subjects: [...originalEvidence.subjects, ...otherEvidence.subjects] })).isError).toBe(true);
  expect(count()).toBe(beforeMismatch);
  revokeSourceGrant(f.db, { source_key: evidence.source, expected_revision: 1, operation_id: "outcome-revoke" });
  const revoked = await call(actor.client, "propose", input(actor.subject, evidence.quote));
  expect(errorOf(revoked).error).toBe("not_found");
  expect(count()).toBe(beforeMismatch);
  expect(beforeMismatch).toBe(before + 2);
}, 120000);

for (const action of ["source", "grant"] as const) test(`scoped outcome ${action} withdrawal during preparation refuses atomically`, async () => {
  const { f, actors, capture, count } = await setup();
  const actor = actors[0]!, evidence = await capture(`outcome.race.${action}`, actor.client), before = count();
  const pending = servePropose(actor.ctx, input(actor.subject, evidence.quote), "kizuki.envelope/v2");
  if (action === "source") revokeSourceGrant(f.db, { source_key: evidence.source, expected_revision: 1, operation_id: "outcome-race-revoke" });
  else setGrant(f.db, actor.name, { subjects: [] });
  await expect(pending).rejects.toMatchObject({ code: "not_found" });
  expect(count()).toBe(before);
}, 120000);

test("ordinary and unbound scoped proposals keep occurrence selection; bound outcomes keep gate selection and grants", async () => {
  const { f, actors, capture, count, seeded } = await setup();
  const actor = actors[0]!, evidence = await capture("outcome.selections", actor.client), before = count();
  const ordinary = { ...input(actor.subject, evidence.quote), predicate: "procedure.step", object: { kind: "literal", value: "Inspect delivery" } };
  expect(errorOf(await call(actor.client, "propose", ordinary)).error).toBe("invalid_arguments");
  expect(errorOf(await call(actor.client, "propose", input(actor.subject, evidence.quote, "outcome.observation", { subjectRef: "none" }))).error).toBe("invalid_arguments");
  await expect(servePropose({ ...actor.ctx, selection: { source: { sourceKey: seeded.sourceKey, captureEventId: null } } },
    input(actor.subject, evidence.quote), "kizuki.envelope/v2")).rejects.toMatchObject({ code: "not_found" });
  setGrant(f.db, actor.name, { subjects: ["procedure:verify"] });
  expect(errorOf(await call(actor.client, "propose", input(actor.subject, evidence.quote))).error).toBe("not_found");
  expect(count()).toBe(before);
}, 120000);
