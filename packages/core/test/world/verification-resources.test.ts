import { expect, test } from "bun:test";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { WORLD_VERIFICATION_OPERATIONS, verificationInputs, verificationScene } from "../helpers/world-verification";
import { worldSeed } from "../helpers/world-seed";

test("all world operations retain bounded output and reader work on a 5000-claim corpus", async () => {
  const scene = await verificationScene();
  try {
    // Retain capabilities before expansion makes the Concept intentionally incomplete.
    // The measured reads still see every claim in the expanded corpus.
    const inputs = verificationInputs(scene);
    await worldSeed(scene.db, { sourceKey: scene.visible.concept.sourceKey, subject: "topic:bayes", label: "Bayesian updating",
      discover: false, predicates: Array.from({ length: 5_000 }, (_, i) => ({ predicate: "concept.example",
        object: { kind: "literal" as const, value: `Synthetic observation ${i}.` } })) });
    expect(scene.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE status='live'").get()!.n).toBeGreaterThanOrEqual(5_000);
    for (const name of WORLD_VERIFICATION_OPERATIONS) {
      const observed = collectReadFrames(() => serveWorldView(scene.reader, inputs[name]));
      expect(Buffer.byteLength(JSON.stringify(observed.result)), `${name}: response bytes`).toBeLessThanOrEqual(256 * 1024);
      expect(observed.frames.reduce((sum, frame) => sum + frame.stats.claimsVerified, 0), `${name}: request-wide verified candidates`).toBeLessThanOrEqual(129);
      for (const frame of observed.frames) {
        // The 128 admitted candidates plus one sentinel establish honest overflow.
        expect(frame.stats.claimsVerified, `${name}: verified candidates`).toBeLessThanOrEqual(129);
        expect(frame.budget.claimVerifications, `${name}: shared eligibility allowance`).toBeLessThanOrEqual(129);
        expect(frame.stats.rowsExamined, `${name}: rows including support lookups`).toBeLessThanOrEqual(1_024);
        expect(frame.budget.bytes, `${name}: parsed support budget`).toBeLessThanOrEqual(2 * 1024 * 1024);
      }
      if (name === "concept") {
        expect(observed.result.data).toMatchObject({ result: { status: "incomplete", data: { coverage: { gaps: expect.arrayContaining(["traversal_limit"]) } } } });
      }
    }
  } finally { scene.dispose(); }
}, 240_000);
