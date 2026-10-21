import { expect, test } from "bun:test";
import { join } from "node:path";
import { addAgent, authenticate, OWNER, OWNER_AGENT_GRANT } from "../../src/agents";
import { insertClaim, prepareClaimInsert, markClaimReverted } from "../../src/claims/store";
import { assertObservations, checkedObservation } from "../../src/claims/observations";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { validateObservation, type Observation } from "../../src/contracts/observation";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant, setSourceGrant, inspectSourceGrant } from "../../src/ledger/source-grants";
import { rebuildWorldLayer } from "../../src/derived";
import { serveWorldView } from "../../src/serving/world-view";
import { referenceScope } from "../../src/world/ref-kinds/common";
import { issueWorldRef } from "../../src/world/references";
import { worldDependencies, worldDependenciesCurrent } from "../../src/world/dependencies";
import { observationOp } from "../../src/world/ops/observation";
import { WORLD_OPS } from "../../src/world/ops/registry";
import { validEvent } from "../fixtures";
import { worldSeed } from "../helpers/world-seed";
import { tempVault } from "../helpers/vault";

async function fixture() {
  const vault = tempVault("kizuki-observation-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const seed = await worldSeed(db, { subject: "topic:observed", connector: "observation.fixture", discover: false });
  const base = readClaimV2Semantic(db, seed.claims.at(-1)!)!;
  if (base.discriminator !== "assertion") throw Error("fixture missing assertion");
  const events = [0, 1].map(i => {
    const result = accept(db, { ...validEvent(), connector_id: "observation.fixture", source_record_id: `obs-${i}`,
      text: `Exact source text ${i}: improve the procedure.`, sensitivity_hint: "public",
      subjects: [{ subject_id: "topic:observed", role: "about" }, { subject_id: "person:sender", role: "from" }, { subject_id: "person:recipient", role: "to" }],
    }, { source: { source_key: seed.sourceKey, expected_revision: 1 } });
    if (result.status !== "stored") throw Error("event refused"); return result.event;
  });
  const semantic = { ...base, schema: "kizuki.claim/v2" as const, perspective: { ...base.perspective, anchors: [] }, object: { kind: "literal" as const, value: "Observed definition" }, anchors: events.map(e => ({ event_id: e.event_id, start_utf16: 0, end_utf16: 5 })) };
  const input = { kind: "claim" as const, body: "Observed definition", provenance: events.map(e => e.event_id), producer: "deterministic" as const,
    confidence: 0.5, semantic, world_admission: { schema: "kizuki.world-admission/v1" as const, semantic, rendering: { body: "Observed definition", frontmatter: {} }, authority: "model_inference" as const, confidence: 0.5, epistemicKind: "model_inference" as const } };
  const inserted = await insertClaim({ db }, input);
  if (inserted.outcome !== "stored") throw Error("claim refused");
  const row = db.query<{ observation_id: string; support_key: string; record: string }, [string]>("SELECT o.* FROM world_observations o JOIN claim_v2_support s USING(support_key) WHERE s.claim_id=?").get(inserted.claim.claim_id);
  expect(row).not.toBeNull();
  const ctx = { db, vaultPath: vault.path, principal: OWNER };
  const admission = db.transaction(() => { const scope = referenceScope(ctx); return issueWorldRef(db, scope.ns, "admission", row!.support_key); }).immediate();
  const read = (ref = admission, knownAt: object = { kind: "current" }, context = ctx) => serveWorldView(context, { operation: "observation", ref, valid: { kind: "all" }, knownAt });
  return { db, vault, seed, ctx, events, input, claim: inserted.claim.claim_id, row: row!, admission, read, dispose() { db.close(); vault.dispose(); } };
}
function observation(value: ReturnType<typeof serveWorldView>): Observation {
  const data = value.data;
  expect(data).toHaveProperty("operation", "observation");
  if (!("result" in data) || !("data" in data.result)) throw Error("observation unavailable");
  expect(validateObservation(data.result.data).ok).toBe(true);
  return data.result.data as Observation;
}

test("checked admission produces exact spans and source-field attribution with opaque public identities", async () => {
  const f = await fixture(); try {
    const output = observation(f.read());
    expect(output.evidence).toHaveLength(6);
    expect(output.attribution).toHaveLength(4);
    expect(output.attribution.map(a => a.role).sort()).toEqual(["recipient", "recipient", "sender", "sender"]);
    expect(output.attribution.every(a => a.ref.kind === "captured_subject" && a.evidence.length === 1 && a.evidence[0]!.span.kind === "metadata")).toBe(true);
    expect(output).not.toHaveProperty("holder");
    const json = JSON.stringify(output);
    for (const raw of [f.seed.sourceKey, f.claim, f.row.observation_id, f.row.support_key, ...f.events.map(e => e.event_id), "person:sender", "person:recipient", "observation.fixture"]) expect(json).not.toContain(raw);
    const again = serveWorldView(f.ctx, { operation: "observation", ref: output.ref, valid: { kind: "all" }, knownAt: { kind: "current" } });
    expect(observation(again)).toEqual(output);
    assertObservations(f.db);
  } finally { f.dispose(); }
}, 120_000);

test("recorded-time cutoffs exclude later observation and correction never relabels the old selection", async () => {
  const f = await fixture(); try {
    const before = observation(f.read());
    expect(f.read(f.admission, { kind: "time", at: "2000-01-01T00:00:00.000Z" }).data).toEqual({ status: "not_found" });
    expect(observation(f.read(f.admission, { kind: "time", at: before.admittedAt }))).toEqual(before);
    markClaimReverted(f.db, f.claim, new Date().toISOString());
    expect(observation(f.read())).toEqual(before);
    expect(f.db.query("SELECT record FROM world_observations WHERE observation_id=?").get(f.row.observation_id)).toEqual({ record: f.row.record });
  } finally { f.dispose(); }
}, 120_000);

test("namespace, source field loss, unknown and erased observation refs all answer not found", async () => {
  const f = await fixture(); try {
    const output = observation(f.read());
    const agent = addAgent(f.db, "observation-other", OWNER_AGENT_GRANT);
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const request = { operation: "observation", valid: { kind: "all" }, knownAt: { kind: "current" } };
    const read = (ref: object) => serveWorldView(ctx, { ...request, ref }).data;
    expect(read(output.ref)).toEqual(read({ kind: "observation", token: "A".repeat(43) }));
    const current = inspectSourceGrant(f.db, f.seed.sourceKey)!;
    setSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: current.revision, operation_id: "observation-no-subjects", policy: { ...current.policy, allowed_fields: ["text"] } });
    expect(f.read().data).toEqual({ status: "not_found" });
    revokeSourceGrant(f.db, { source_key: f.seed.sourceKey, expected_revision: 2, operation_id: "observation-revoke" });
    expect(f.db.query("SELECT 1 FROM world_observations WHERE observation_id=?").get(f.row.observation_id)).toBeNull();
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(output.ref.token)).toBeNull();
    expect(f.read().data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
}, 120_000);

test("loss of any required event removes the whole observation and its publication dependency", async () => {
  const f = await fixture(); try {
    const deps = worldDependencies();
    f.db.transaction(() => {
      const scope = referenceScope(f.ctx);
      expect(observationOp.run({ ...scope, registry: WORLD_OPS, dependencies: deps }, f.admission, { valid: { kind: "all" }, knownAt: { kind: "current" } }).status).toBe("data");
      expect(worldDependenciesCurrent(f.ctx, deps)).toBe(true);
    }).immediate();
    const output = observation(f.read());
    purgeEvents(f.db, f.vault.path, { event_id: f.events[1]!.event_id }, "erase required event");
    expect(f.db.query("SELECT 1 FROM events WHERE event_id=?").get(f.events[0]!.event_id)).not.toBeNull();
    expect(f.db.query("SELECT 1 FROM world_observations WHERE observation_id=?").get(f.row.observation_id)).toBeNull();
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(output.ref.token)).toBeNull();
    expect(worldDependenciesCurrent(f.ctx, deps)).toBe(false);
    expect(f.read().data).toEqual({ status: "not_found" });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

test("writer rollback and actual export/restore retain exact normalized records while token caches reset", async () => {
  const f = await fixture(), storage = tempVault("kizuki-observation-backup-"); try {
    const records = () => f.db.query("SELECT * FROM world_observations ORDER BY observation_id").all();
    const before = records(), output = observation(f.read());
    const prepared = await prepareClaimInsert({ db: f.db }, { ...f.input, semantic: { ...f.input.semantic, object: { kind: "literal", value: "rollback" } }, world_admission: { ...f.input.world_admission, semantic: { ...f.input.semantic, object: { kind: "literal", value: "rollback" } } } });
    expect(() => f.db.transaction(() => { prepared.apply(); throw Error("rollback"); }).immediate()).toThrow("rollback");
    expect(records()).toEqual(before);
    rebuildWorldLayer(f.db); expect(records()).toEqual(before);
    const backup = join(storage.path, "backup"), restored = join(storage.path, "restored");
    exportVault(f.db, f.vault.path, backup); restoreVault(backup, restored);
    const db = openLedger(join(restored, ".kizuki/kizuki.db")); try {
      assertObservations(db); expect(db.query("SELECT * FROM world_observations ORDER BY observation_id").all()).toEqual(before);
      expect(db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(output.ref.token)).toBeNull();
      expect(checkedObservation(db, f.row.observation_id)?.record).toEqual(JSON.parse(f.row.record));
    } finally { db.close(); }
  } finally { f.dispose(); storage.dispose(); }
}, 120_000);
