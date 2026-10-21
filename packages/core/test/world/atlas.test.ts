import { expect, test, setDefaultTimeout } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { validateAtlas, ATLAS_PANELS, type Atlas } from "../../src/contracts/atlas";
import { verificationScene } from "../helpers/world-verification";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { hiddenScene } from "../helpers/noninterference";
import { worldSeed } from "../helpers/world-seed";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { wireDigest } from "../../src/world/views/store";
import { compileAtlas } from "../../src/world/atlas/compile";
import { worldNamespace } from "../../src/world/references";
import { artifactFixture } from "../helpers/artifact-fixture";
import { serveCorrect } from "../../src/serving/correct";
import { situationV2Fixture } from "../helpers/situation-v2-fixture";

setDefaultTimeout(120_000);
const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
function atlas(value: ReturnType<typeof serveWorldView>): Atlas {
  if (!("result" in value.data) || !("data" in value.data.result) || value.data.result.data.schema !== "kizuki.atlas/v1") throw Error(`Atlas body required: ${JSON.stringify(value.data)}`);
  expect(validateAtlas(value.data.result.data).ok).toBe(true);
  return value.data.result.data;
}
test("all Atlas panels have closed bodies and normal composition creates no retained views", async () => {
  const f = await verificationScene();
  try {
    const before = f.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all();
    for (const panel of ATLAS_PANELS) {
      const reply = serveWorldView(f.reader, { operation: "atlas", panel, ...when });
      const data = atlas(reply);
      expect(data.panel).toBe(panel);
      expect(data.panels).toHaveLength(panel === "home" ? 7 : 1);
      expect(JSON.stringify(reply).length).toBeLessThan(256 * 1024);
      expect(reply.quoted).toEqual([]);
      expect(reply.data).not.toHaveProperty("result.view.kind");
    }
    expect(f.db.query("SELECT token_hash FROM world_view_tokens ORDER BY token_hash").all()).toEqual(before);
  } finally { f.dispose(); }
});
test("Atlas preserves whole Person relations and evidence for the actual consumer", async () => {
  const f = await verificationScene();
  try {
    const data = atlas(serveWorldView(f.reader, { operation: "atlas", panel: "people", ...when }));
    expect(data.panels[0]!.entries.length).toBeGreaterThan(0);
    const entry = data.panels[0]!.entries[0]!;
    const card = serveWorldView(f.reader, { operation: "person", person: entry.ref, ...when }).data;
    expect(entry.relations.length).toBeGreaterThan(0);
    for (const relation of entry.relations) {
      expect(JSON.stringify(card)).toContain(JSON.stringify(relation));
      for (const evidence of relation.perspective.evidence) {
        expect(serveWorldView(f.reader, { operation: "evidence", evidence, ...when }).data).toHaveProperty("result.data.schema", "kizuki.world-evidence/v1");
      }
    }
  } finally { f.dispose(); }
});
test("missing panel providers are unavailable coverage, never empty", async () => {
  const f = await verificationScene();
  try {
    const result = f.db.transaction(() => compileAtlas({ ctx: f.reader, ns: worldNamespace(f.db, f.reader.principal), registry: [], read: () => { throw Error("missing provider must not run"); } }, { panel: "home", focus: null, baselineView: null }, when)).immediate();
    expect(validateAtlas(result.data).ok).toBe(true);
    for (const panel of result.data.panels) expect(panel).toMatchObject({ status: "unavailable", reason: "not_landed", coverage: { status: "partial", gaps: ["coverage"] } });
  } finally { f.dispose(); }
});
test("Atlas changes use DIFF and lose baseline authority on revoke without old identifiers", async () => {
  const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.vaultPath);
    const focus = { operation: "concept", ref: f.refs.concept };
    const first = serveWorldView(f.reader, { operation: "concept", concept: focus.ref, ...when }).data;
    if (!("result" in first) || first.result.status !== "current" || !("kind" in first.result.view)) throw Error("baseline required");
    const request = { operation: "atlas", panel: "changed", focus, baselineView: first.result.view, ...when };
    expect(atlas(serveWorldView(f.reader, request)).panels[0]).toMatchObject({ status: "empty", change: { added: [], removed: [], changed: [] }, nextView: first.result.view });
    await worldSeed(f.db, { sourceKey: f.visible.concept.sourceKey, subject: "topic:bayes", label: "Bayesian updating", discover: false, predicates: [{ predicate: "concept.definition", object: { kind: "literal", value: "A new visible definition" } }] });
    await completeEmptyWorldSummaries(f.db, f.vaultPath);
    const changed = atlas(serveWorldView(f.reader, request)).panels[0]!;
    expect(changed.status).toBe("ready"); expect(changed.change!.added.length).toBeGreaterThan(0);
    revokeSourceGrant(f.db, { source_key: f.visible.concept.sourceKey, expected_revision: 1, operation_id: "atlas-revoke" });
    const revoked = serveWorldView(f.reader, request);
    expect(atlas(revoked).panels[0]).toMatchObject({ status: "unavailable", reason: "baseline_unusable", change: null, nextView: null });
    expect(JSON.stringify(revoked)).not.toContain(first.result.view.token);
    expect(JSON.stringify(revoked)).not.toContain(f.refs.concept.token);
  } finally { f.dispose(); }
});
test("a first panel baseline erased after a later panel cannot escape the final publication check", async () => {
  const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.vaultPath);
    const first = serveWorldView(f.reader, { operation: "concept", concept: f.refs.concept, ...when }).data;
    if (!("result" in first) || first.result.status !== "current" || !("kind" in first.result.view)) throw Error("baseline required");
    const baseline = first.result.view; let erased = false, assembledBeforeErasure = false;
    const db = new Proxy(f.db, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transaction") return (run: () => unknown) => {
        const tx = target.transaction(run), finish = (value: unknown) => {
          if (!erased && !target.inTransaction && value !== null && typeof value === "object" && "withheld" in value) {
            const assembled = value as unknown as { data: { result: { data?: Atlas } } };
            const panels = assembled.data.result.data?.panels;
            assembledBeforeErasure = panels?.length === 7 && panels[1]?.nextView?.token === baseline.token;
            erased = true; target.query("DELETE FROM world_view_tokens WHERE token_hash=?").run(wireDigest(baseline.token));
          }
          return value;
        };
        return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()), deferred: () => finish(tx.deferred()), exclusive: () => finish(tx.exclusive()) });
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const reply = serveWorldView({ ...f.reader, db }, { operation: "atlas", panel: "home", focus: { operation: "concept", ref: f.refs.concept }, baselineView: baseline, ...when });
    expect(erased).toBe(true);
    expect(assembledBeforeErasure).toBe(true);
    const data = atlas(reply);
    for (const panel of data.panels.filter(one => one.panel === "changed" || one.panel === "corrections")) expect(panel).toMatchObject({ status: "unavailable", reason: "baseline_unusable", change: null, nextView: null });
    expect(JSON.stringify(reply)).not.toContain(baseline.token);
    expect(reply.quoted).toEqual([]);
  } finally { f.dispose(); }
});

test("Atlas correction entries retain owner authority and show real removed and replacement claims", async () => {
  const f = await artifactFixture();
  try {
    const artifact = await f.capture("Synthetic Atlas artifact");
    await artifact.feedback("Old inspection feedback", { mode: "asserted" });
    const ref = artifact.ref(), first = serveWorldView(f.ctx, { operation: "artifact_version", artifact: ref, ...when }).data;
    if (!("result" in first) || first.result.status !== "current" || !("kind" in first.result.view) || first.result.data.schema !== "kizuki.artifact-card/v1") throw Error("artifact baseline required");
    const old = first.result.data.inspections[0]!.claim;
    await serveCorrect(f.ctx, { statement: "Use the corrected inspection.", target: { world_claim: old }, mode: "replace_object", object: { kind: "literal", value: "Corrected inspection feedback" } });
    const data = atlas(serveWorldView(f.ctx, { operation: "atlas", panel: "corrections", focus: { operation: "artifact_version", ref }, baselineView: first.result.view, ...when }));
    const panel = data.panels[0]!;
    expect(panel.change!.removed).toContainEqual(old);
    expect(panel.change!.added).toHaveLength(1);
    expect(panel.entries).toHaveLength(1);
    expect(panel.entries[0]!.relations).toHaveLength(1);
    expect(panel.entries[0]!.relations[0]!.object).toEqual({ kind: "literal", value: "Corrected inspection feedback" });
    expect(panel.entries[0]!.relations[0]!.assessments.some(one => one.authority === "owner_correction")).toBe(true);
  } finally { f.dispose(); }
});

test("Atlas stale evidence shows current consolidation gaps and refuses unknown input keys", async () => {
  const f = await hiddenScene({ model: EMPTY_SUMMARY_MODEL });
  try {
    const data = atlas(serveWorldView(f.reader, { operation: "atlas", panel: "stale", ...when }));
    expect(data.panels[0]!.status).toBe("partial");
    expect(data.panels[0]!.entries.length).toBeGreaterThan(0);
    expect(data.coverage.gaps).toContain("pending_consolidation");
    for (const own of [{ panel: null }, { panel: "wrong" }, { panel: "people", limit: 50 }, { focus: { operation: "atlas", ref: f.refs.concept } }, { baselineView: { kind: "view", token: "invalid" } }]) {
      expect(() => serveWorldView(f.reader, { operation: "atlas", ...own, ...when })).toThrow("invalid arguments: world_view");
    }
  } finally { f.dispose(); }
});

test("Atlas comparison preserves a Situation v2 baseline selector", async () => {
  const f = await situationV2Fixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const ref = f.findSituation();
    const first = serveWorldView(f.ctx, { operation: "situation", situation: ref, card: "kizuki.situation-card/v2", ...when }).data;
    if (!("result" in first) || first.result.status !== "current" || !("kind" in first.result.view)) throw Error("v2 baseline required");
    const input = { operation: "atlas", panel: "changed", focus: { operation: "situation", ref, card: "kizuki.situation-card/v2" }, baselineView: first.result.view, ...when };
    expect(atlas(serveWorldView(f.ctx, input)).panels[0]).toMatchObject({ status: "empty", change: { added: [], removed: [], changed: [] }, nextView: first.result.view });
    expect(atlas(serveWorldView(f.ctx, { ...input, focus: { operation: "situation", ref } })).panels[0]).toMatchObject({ status: "unavailable", reason: "baseline_unusable", change: null });
  } finally { f.dispose(); }
});
