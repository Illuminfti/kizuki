import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { serveCorrect } from "../../src/serving/correct";
import { createRedactor, redactValue } from "../../src/serving/redact";
import { serveWorldView } from "../../src/serving/world-view";
import { worldNamespace } from "../../src/world/references";
import { wireDigest } from "../../src/world/views/store";
import { issuedOpaqueFields } from "../../src/util/issued-opaque";
import { hiddenScene } from "../helpers/noninterference";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";

// A real 32-byte generated wire identity that happens to contain a credential prefix.
const COLLISION = "gqmPUP5-sk-TmqqDmrkxvBtq0EwM4vte68qMKLDBKB0";
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;

test.each(["claim", "admission", "event_version"] as const)("a credential-shaped issued %s identity survives serving and remains usable", async (kind) => {
  const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.vaultPath);
    const agent = addAgent(f.db, "opaque-correction-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const ctx = { ...f.reader, principal: authenticate(f.db, agent.token)! };
    const found = serveWorldView(ctx, { operation: "find_concepts", label: "Bayesian updating", ...WHEN }).data;
    if (!("result" in found) || !("data" in found.result) || !("matches" in found.result.data)) throw new Error("missing discovery");
    f.db.transaction(() => {
      const ns = worldNamespace(f.db, ctx.principal);
      // Discovery already retained this event dependency. Replace that random
      // identity in the synthetic fixture before the card issues its refs.
      if (kind === "event_version")
        f.db.query(`DELETE FROM world_wire_refs WHERE namespace_id=? AND wire_ref IN
          (SELECT wire_ref FROM world_wire_event_version_targets WHERE namespace_id=? AND event_id=?)`).run(ns.id, ns.id, f.visible.concept.eventId);
      f.db.query("INSERT INTO world_wire_refs(namespace_id,wire_ref,ref_kind) VALUES (?,?,?)").run(ns.id, COLLISION, kind);
      if (kind === "claim")
        f.db.query("INSERT INTO world_wire_claim_targets(namespace_id,wire_ref,claim_id) VALUES (?,?,?)").run(ns.id, COLLISION, f.visible.concept.claims[2]!);
      else if (kind === "admission")
        f.db.query("INSERT INTO world_wire_admission_targets(namespace_id,wire_ref,support_key) SELECT ?,?,support_key FROM claim_v2_support WHERE claim_id=?").run(ns.id, COLLISION, f.visible.concept.claims[2]!);
      else
        f.db.query(`INSERT INTO world_wire_event_version_targets(namespace_id,wire_ref,event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at)
          SELECT ?,?,event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at FROM events WHERE event_id=?`).run(ns.id, COLLISION, f.visible.concept.eventId);
    }).immediate();
    const input = { operation: "concept", concept: found.result.data.matches[0]!.ref, ...WHEN };
    const first = serveWorldView(ctx, input).data;
    if (!("result" in first) || first.result.status !== "current" || first.result.data.schema !== "kizuki.concept-card/v1") throw new Error("missing card");
    const claim = first.result.data.definitions[0]!.claim;
    const evidence = first.result.data.definitions[0]!.assessments[0]!.evidence[0]!;
    expect((kind === "claim" ? claim : kind === "admission" ? evidence.admission : evidence.eventVersion).token).toBe(COLLISION);
    expect(serveWorldView(ctx, { ...input, priorView: first.result.view }).data)
      .toMatchObject({ result: { status: "unchanged", view: first.result.view } });
    const expanded = serveWorldView(ctx, { operation: "evidence", evidence, ...WHEN });
    expect(expanded.quoted).toHaveLength(1);
    expect(expanded.quoted[0]!.evidence).toEqual(evidence);
    const corrected = await serveCorrect(ctx, {
      statement: "Revise beliefs only with independent evidence.", target: { world_claim: claim },
    });
    expect(corrected.data).toHaveProperty("claim_id");
    expect(f.db.query("SELECT status FROM claims WHERE claim_id=?").get(f.visible.concept.claims[2]!)).toEqual({ status: "superseded" });
  } finally { f.dispose(); }
}, 120_000);

test("reference-shaped captured objects and quoted strings still lose credential-shaped spans", () => {
  const fake = { kind: "claim", token: COLLISION };
  const redacted = redactValue(createRedactor({ kind: "agent" }), {
    fake, json: { toJSON: () => fake }, quoted: `Quoted identity ${COLLISION}`,
  });
  expect(JSON.stringify(redacted)).not.toContain(COLLISION);
  expect(JSON.stringify(redacted)).toContain("[redacted:api_token]");
});

test("opaque output trust belongs to immutable issued objects, never copied values or other fields", () => {
  const minted = issuedOpaqueFields({ kind: "claim", token: COLLISION, label: COLLISION }, ["token"]);
  expect(Object.isFrozen(minted)).toBe(true);
  expect(Reflect.set(minted, "token", "replacement")).toBe(false);
  const result = redactValue(createRedactor({ kind: "agent" }), {
    minted, copied: { ...minted }, parsed: JSON.parse(JSON.stringify(minted)),
    prose: COLLISION, fakeJson: { toJSON: () => ({ ...minted }) },
  });
  expect(result.minted.token).toBe(COLLISION);
  expect(result.minted.label).not.toBe(COLLISION);
  for (const value of [result.copied, result.parsed, result.prose, result.fakeJson])
    expect(JSON.stringify(value)).not.toContain(COLLISION);
  expect(() => issuedOpaqueFields({ token: "not-a-wire-value" }, ["token"])).toThrow("invalid issued opaque field");
});

// Substitute a deterministic random-token value in the synthetic cache while
// retaining its complete query scope, expiry, payload and erasure dependencies.
function cloneCacheToken(db: Database, oldHash: string, newHash: string) {
  db.transaction(() => {
    const inserted = db.query(`INSERT INTO world_view_tokens
      SELECT ?,partition_id,namespace_id,query_digest,projection,fingerprint,bytes,created_at,expires_at
      FROM world_view_tokens WHERE token_hash=?`).run(newHash, oldHash);
    expect(inserted.changes).toBe(1);
    db.query("INSERT INTO world_view_token_deps SELECT ?,namespace_id,wire_ref FROM world_view_token_deps WHERE token_hash=?").run(newHash, oldHash);
  }).immediate();
}

test("validated prior views and supplied historical snapshots retain credential-shaped identities", async () => {
  const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
  try {
    // The historical cutoff must already include the synthetic completion.
    const completedAt = f.db.query<{ at: string }, []>("SELECT max(recorded_at) AS at FROM claim_lifecycle_history").get()!.at;
    await completeEmptyWorldSummaries(f.db, f.vaultPath, () => completedAt);
    const input = { operation: "concept", concept: f.refs.concept, ...WHEN };
    const first = serveWorldView(f.reader, input).data;
    if (!("result" in first) || first.result.status !== "current" || !("kind" in first.result.view)) throw new Error("missing view");
    cloneCacheToken(f.db, wireDigest(first.result.view.token), wireDigest(COLLISION));
    const priorView = { kind: "view", token: COLLISION };
    expect(serveWorldView(f.reader, { ...input, priorView }).data).toMatchObject({ result: { status: "unchanged", view: priorView } });
    const historical = serveWorldView(f.reader, { ...input, knownAt: { kind: "time", at: new Date().toISOString() } }).data;
    if (!("result" in historical) || historical.result.status !== "current" || historical.result.data.schema !== "kizuki.concept-card/v1" || historical.result.data.knownAt.kind !== "snapshot") throw new Error("missing historical snapshot");
    const snapshotHash = (token: string) => createHash("sha256").update("known-snapshot\0").update(Buffer.from(token, "base64url")).digest("hex");
    cloneCacheToken(f.db, snapshotHash(historical.result.data.knownAt.ref.token), snapshotHash(COLLISION));
    const knownAt = { kind: "snapshot", ref: { kind: "snapshot", token: COLLISION } };
    const loaded = serveWorldView(f.reader, { ...input, knownAt }).data;
    expect(loaded).toMatchObject({ result: { status: "current", data: { knownAt } } });
    if (!("result" in loaded) || loaded.result.status !== "current") throw new Error("missing loaded snapshot");
    expect(serveWorldView(f.reader, { ...input, knownAt, priorView: loaded.result.view }).data)
      .toMatchObject({ result: { status: "unchanged", view: loaded.result.view } });
    f.db.query("DELETE FROM world_view_tokens WHERE token_hash=?").run(snapshotHash(COLLISION));
    expect(serveWorldView(f.reader, { ...input, knownAt }).data).toMatchObject({ result: { status: "new_view_required" } });
  } finally { f.dispose(); }
}, 120_000);
