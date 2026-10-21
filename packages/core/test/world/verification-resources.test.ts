import { expect, test } from "bun:test";
import type { SuppliedNamespace } from "../../src/contracts/claim-v2";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { anchorOf } from "../../src/world/pipeline/collect";
import { resolveWorldObject, worldNamespace } from "../../src/world/references";
import { WORLD_VERIFICATION_OPERATIONS, verificationInputs, verificationScene } from "../helpers/world-verification";
import { worldSeed } from "../helpers/world-seed";

test("all world operations retain bounded output and reader work on a 5000-claim corpus", async () => {
  const scene = await verificationScene();
  try {
    // Retain capabilities before expansion makes the Concept intentionally incomplete.
    // The measured reads still see every claim in the expanded corpus.
    const inputs = verificationInputs(scene);
    // Composite fixtures contain equal labels/raw IDs in different source
    // namespaces. Expand the exact endpoint the retained reader capability names.
    const concept = scene.db.transaction(() => {
      const handle = resolveWorldObject(scene.db, worldNamespace(scene.db, scene.reader.principal), scene.refs.concept.token);
      return handle === null ? null : anchorOf(scene.db, handle);
    })();
    if (concept?.kind !== "supplied" || !("namespace" in concept))
      throw new Error("resource fixture requires the selected source-qualified Concept");
    const namespace = concept.namespace as SuppliedNamespace;
    await worldSeed(scene.db, { sourceKey: namespace.source_key, connector: namespace.connector_id,
      subject: concept.id, label: "Bayesian updating",
      discover: false, predicates: Array.from({ length: 5_000 }, (_, i) => ({ predicate: "concept.example",
        object: { kind: "literal" as const, value: `Synthetic observation ${i}.` } })) });
    expect(scene.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE status='live'").get()!.n).toBeGreaterThanOrEqual(5_000);
    expect(scene.db.query<{ n: number }, [string, string, string]>(`SELECT count(*) AS n
      FROM claim_v2_semantics s JOIN claims c USING(claim_id)
      WHERE c.status='live' AND s.predicate='concept.example' AND s.subject_id=?
        AND json_extract(s.payload,'$.subject.namespace.connector_id')=?
        AND json_extract(s.payload,'$.subject.namespace.source_key')=?`)
      .get(concept.id, namespace.connector_id, namespace.source_key)!.n).toBeGreaterThanOrEqual(5_000);
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
        expect(observed.frames.reduce((sum, frame) => sum + frame.stats.claimsVerified, 0)).toBe(129);
        expect(observed.result.data).toMatchObject({ result: { status: "incomplete", data: { coverage: { gaps: expect.arrayContaining(["traversal_limit"]) } } } });
      }
    }
  } finally { scene.dispose(); }
}, 240_000);
