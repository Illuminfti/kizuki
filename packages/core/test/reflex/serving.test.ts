import { afterEach, beforeEach, expect, test } from "bun:test";
import { revokeAgent } from "../../src/agents";
import type { SystemOnePort, SystemOneRequest, SystemOneResponse } from "../../src/contracts/systemone";
import { bindSourceEvent, bindSourceModelPort, setSourceGrant } from "../../src/ledger/source-grants";
import type { SourceGrantPolicy } from "../../src/ledger/source-grants";
import { assessReflex } from "../../src/reflex/serve";
import { REFLEX_LIMITS } from "../../src/reflex/types";
import { serveFixture, storeEvent } from "../serving/helpers";
import type { Fixture } from "../serving/helpers";

let f: Fixture;
beforeEach(async () => { f = await serveFixture(); });
afterEach(() => f.dispose());
const policy: SourceGrantPolicy = {
  purposes: ["capture", "recall", "extract"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", sensitivity_floor: "public",
  egress: { model_endpoint: "https://reflex.invalid/v1/systemone", model: "fixture-model", external_retention: "provider_managed" },
};
const request = (ids: string[]) => ({ assumptions: [{ id: "kettle", statement: "The kettle is on.", importance: "critical" as const }], event_ids: ids, max_age_ms: REFLEX_LIMITS.max_age_ms });
function response(req: SystemOneRequest): SystemOneResponse {
  return { model: "fixture-model", usage: { input_tokens: 12, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(req.questions).map(key => [key, {
    type: "choice", choice: "supports", confidence: 0.94, probabilities: { supports: 0.97, contradicts: 0.01, irrelevant: 0.01, unclear: 0.01 },
  }])) };
}
function fake(run: (req: SystemOneRequest) => Promise<SystemOneResponse>): SystemOnePort {
  return { model_ref: "fixture-model", descriptor: { id: "kizuki.systemone.fixture", kind: "systemone", contract: "kizuki.systemone/v1", contract_minor: 0, supports: ["evaluate"], requires_lease: false, optional_package: null },
    evaluate: run, health: async () => ({ status: "ready", detail: {} }), close: async () => {} };
}
function consent(port: SystemOnePort, ids: string[], sourcePolicy = policy): void {
  setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 0, operation_id: "reflex-fixture-grant", policy: sourcePolicy });
  for (const id of ids) bindSourceEvent(f.db, id, { source_key: f.sourceKey, expected_revision: 1 });
  bindSourceModelPort(port, { model_endpoint: "https://reflex.invalid/v1/systemone", model: "fixture-model" });
}

test("unconfigured is explicit unknown, not an affirmative no-model fallback", async () => {
  const report = await assessReflex(f.owner(), request([f.events.public!]));
  expect(report.reason).toBe("not_configured"); expect(report.findings[0]!.verdict).toBe("unknown");
  expect(report.metrics.dispatched_batches).toBe(0); expect(report.authority).toBe("advisory_only");
});
test("epoch-zero legacy read access is never new model-egress consent", async () => {
  let calls = 0;
  const report = await assessReflex(f.owner(), request([f.events.public!]), { systemone: fake(async req => { calls++; return response(req); }) });
  expect(calls).toBe(0); expect(report.evidence[0]!.eligibility).toBe("model_egress_denied");
  expect(report.reason).toBe("no_eligible_evidence");
});
test("local-only source cannot be sent to a remote bound port", async () => {
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  consent(port, [f.events.public!], { ...policy, egress: "local_only" });
  const report = await assessReflex(f.owner(), request([f.events.public!]), { systemone: port });
  expect(calls).toBe(0); expect(report.evidence[0]!.eligibility).toBe("model_egress_denied");
});
test("exact endpoint and model consent are required separately from read access", async () => {
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  consent(port, [f.events.public!], { ...policy, egress: { model_endpoint: "https://other.invalid/v1/systemone", model: "fixture-model", external_retention: "provider_managed" } });
  expect((await assessReflex(f.owner(), request([f.events.public!]), { systemone: port })).reason).toBe("no_eligible_evidence");
  expect(calls).toBe(0);
});
test("authorized current evidence is assessed without changing claims or source rows", async () => {
  const port = fake(async req => response(req)); consent(port, [f.events.public!]);
  const count = (table: "events" | "claims") => f.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
  const events = count("events"), claims = count("claims");
  const report = await assessReflex(f.agent("reader-public"), request([f.events.public!]), { systemone: port });
  expect(report.status).toBe("assessed"); expect(report.findings[0]!.verdict).toBe("supported");
  expect(report.evidence[0]!.sha256).toMatch(/^[a-f0-9]{64}$/); expect(report.coverage.exhaustive).toBe(false);
  expect(report.requires_revalidation).toBe(true); expect(count("events")).toBe(events); expect(count("claims")).toBe(claims);
  expect(JSON.stringify(report)).not.toContain("the public kettle is on");
});
test("an agent's unreadable source reaches neither the model nor the report", async () => {
  const sent: string[] = []; const port = fake(async req => { sent.push(JSON.stringify(req.state)); return response(req); });
  consent(port, [f.events.public!, f.events.private!]);
  const report = await assessReflex(f.agent("reader-public"), request([f.events.public!, f.events.private!]), { systemone: port });
  expect(report.coverage.readable_events).toBe(1);
  expect(JSON.stringify(report)).not.toContain(f.events.private!); expect(sent.join("")).not.toContain("the private kettle");
});
test("capability and type scopes cannot be bypassed by the library entry point", async () => {
  const port = fake(async req => response(req)); consent(port, [f.events.public!]);
  await expect(assessReflex(f.agent("search-only"), request([f.events.public!]), { systemone: port })).rejects.toMatchObject({ code: "tool_not_granted" });
  const typed = await assessReflex(f.agent("typed"), request([f.events.public!]), { systemone: port });
  expect(typed.evidence).toHaveLength(0); expect(typed.metrics.dispatched_batches).toBe(0);
});
test("source extraction permission is not implied by recall permission", async () => {
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  consent(port, [f.events.public!], { ...policy, purposes: ["capture", "recall"] });
  await assessReflex(f.owner(), request([f.events.public!]), { systemone: port }); expect(calls).toBe(0);
});
test("missing sensitivity, deleted and purged evidence cannot enter judgments", async () => {
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  f.db.query("UPDATE events SET sensitivity_hint = NULL WHERE event_id = ?").run(f.events.public!);
  consent(port, [f.events.public!]);
  const report = await assessReflex(f.owner(), request([f.events.public!, f.events.tombstoned!, f.events.hold!]), { systemone: port });
  expect(report.evidence).toHaveLength(0); expect(calls).toBe(0);
});
test("freshness is arithmetic in core and oversized evidence is not truncated", async () => {
  const now = Date.now();
  const future = storeEvent(f.db, "reflex-future", new Date(now + 60_000).toISOString(), "The kettle is on.", "person:ada", "public");
  const large = storeEvent(f.db, "reflex-large", new Date(now - 1000).toISOString(), "x".repeat(REFLEX_LIMITS.evidence_bytes + 1), "person:ada", "public");
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  consent(port, [f.events.public!, future, large]);
  const report = await assessReflex(f.owner(), { ...request([f.events.public!, future, large]), max_age_ms: 86_400_000 }, { systemone: port });
  expect(report.evidence.map(e => e.eligibility)).toEqual(["stale", "future", "oversized"]);
  expect(report.evidence[2]!.sha256).toBeNull(); expect(calls).toBe(0);
});
test("source policy changes stop queued dispatch and refuse the whole report", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => storeEvent(f.db, `reflex-race-${i}`, new Date(Date.now() - 1000).toISOString(), "The kettle is on.", "person:ada", "public"));
  let calls = 0; const port = fake(async req => {
    calls++;
    setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "reflex-narrow", policy: { ...policy, purposes: ["recall"] } });
    return response(req);
  });
  consent(port, ids);
  await expect(assessReflex(f.owner(), request(ids), { systemone: port })).rejects.toMatchObject({ code: "error" });
  expect(calls).toBe(1);
});
test("agent revocation during a model call prevents result delivery", async () => {
  const ctx = f.agent("reader-private");
  const port = fake(async req => { revokeAgent(f.db, "reader-private"); return response(req); }); consent(port, [f.events.public!]);
  await expect(assessReflex(ctx, request([f.events.public!]), { systemone: port })).rejects.toMatchObject({ code: "error" });
});

test("unrepresentable RFC3339 timestamps cannot bypass freshness checks", async () => {
  let calls = 0; const port = fake(async req => { calls++; return response(req); });
  consent(port, [f.events.public!]);
  f.db.query("UPDATE events SET occurred_at = ? WHERE event_id = ?").run("2026-06-30T23:59:60Z", f.events.public!);
  const report = await assessReflex(f.owner(), request([f.events.public!]), { systemone: port });
  expect(calls).toBe(0); expect(report.evidence).toHaveLength(0);
});
