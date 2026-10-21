import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { ATLAS_PANELS } from "../../src/contracts/atlas";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { HIDDEN_MUTATIONS, checkNoninterference } from "../helpers/noninterference";
import { verificationScene } from "../helpers/world-verification";
import { worldSeed } from "../helpers/world-seed";
const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
for (const mutation of HIDDEN_MUTATIONS) {
  test(`every Atlas panel ignores ${mutation.name} in bytes and work`, async () => {
    expect(await checkNoninterference({ scene: verificationScene, mutations: [mutation], cases: scene => {
      const current = serveWorldView(scene.reader, { operation: "concept", concept: scene.refs.concept, ...when }).data;
      if (!("result" in current) || current.result.status !== "current" || !("kind" in current.result.view)) throw Error("complete Atlas baseline required");
      const comparison = { focus: { operation: "concept", ref: scene.refs.concept }, baselineView: current.result.view };
      return ATLAS_PANELS.map(panel => {
        let work = { frames: 0, rows: 0, verified: 0, bytes: 0 };
        return { name: `atlas:${panel}`, run(ctx) {
          const observed = collectReadFrames(() => serveWorldView(ctx, { operation: "atlas", panel, ...(["home", "changed", "corrections"].includes(panel) ? comparison : {}), ...when }));
          work = { frames: observed.frames.length, rows: observed.frames.reduce((n, frame) => n + frame.stats.rowsExamined, 0), verified: observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0), bytes: Math.max(0, ...observed.frames.map(frame => frame.budget.bytes)) };
          return observed.result;
        }, stats: () => work };
      });
    } })).toEqual([]);
  }, 180_000);
}
test("all Atlas panels share bounded parsing and projection work on 5000 claims", async () => {
  const f = await verificationScene();
  try {
    await worldSeed(f.db, { sourceKey: f.visible.concept.sourceKey, subject: "topic:bayes", label: "Bayesian updating", discover: false,
      predicates: Array.from({ length: 5000 }, (_, i) => ({ predicate: "concept.example", object: { kind: "literal" as const, value: `Synthetic Atlas observation ${i}` } })) });
    expect(f.db.query<{n:number},[]>("SELECT count(*) AS n FROM claims WHERE status='live'").get()!.n).toBeGreaterThanOrEqual(5000);
    for (const panel of ATLAS_PANELS) {
      const observed = collectReadFrames(() => serveWorldView(f.reader, { operation: "atlas", panel, ...when }));
      expect(observed.frames.length, panel).toBeLessThanOrEqual(32);
      expect(new Set(observed.frames.map(frame => frame.budget)).size, panel).toBeLessThanOrEqual(1);
      expect(Buffer.byteLength(JSON.stringify(observed.result)), panel).toBeLessThanOrEqual(256 * 1024);
      expect(observed.frames.reduce((n, frame) => n + frame.stats.rowsExamined, 0), panel).toBeLessThanOrEqual(32 * 1024);
      // The resume slice deliberately shares a frame across five kind discoveries
      // and at most four cards per kind; 129 is a per-read candidate bound, not
      // a per-frame bound. Check the derived composition bound, not a single card.
      expect(observed.frames.reduce((n, frame) => n + frame.stats.claimsVerified, 0), panel).toBeLessThanOrEqual((32 + 5 * 5) * 129);
      for (const frame of observed.frames) {
        expect(frame.stats.claimsVerified, panel).toBeLessThanOrEqual(5 * 5 * 129);
        expect(frame.stats.rowsExamined, panel).toBeLessThanOrEqual(5 * 5 * 1024);
        expect(frame.budget.bytes, panel).toBeLessThanOrEqual(2 * 1024 * 1024);
      }
    }
  } finally { f.dispose(); }
}, 240_000);
