import { expect, test } from "bun:test";
import { collectReadFrames, withWorldPipeline } from "@kizuki/core/testing";
import { readWorldView } from "@kizuki/core/world";
import { worldFixture } from "../serving/world-fixture";
import { openLedger } from "../../src/ledger/db";
import { supportLineage } from "../../src/world/lineage";
import type { Enricher } from "../../src/world/pipeline/enrich";
import { cardFixture } from "./card-fixture";

test("distinct source definitions supply two roots, exact copied text supplies none extra", async () => {
  const db = openLedger(":memory:");
  try {
    const original = await worldFixture(db, { subject: "topic:original", label: "Original wording" });
    await worldFixture(db, { subject: "topic:independent", label: "An independently phrased note" });
    await worldFixture(db, { subject: "topic:copy", label: "Original wording" });
    const handles = db.query<{ handle_id: string }, []>("SELECT handle_id FROM semantic_bindings ORDER BY handle_id").all().map((r) => r.handle_id);
    let count = -1;
    const inspect: Enricher = (frame, body) => {
      const supports = body.claims.filter((claim) => claim.relation.predicate === "concept.definition").flatMap((claim) => claim.eligible.supports);
      const forward = supportLineage(frame, supports), backward = supportLineage(frame, [...supports].reverse());
      expect(forward.roots).toEqual(backward.roots);
      expect([...forward.independence]).toEqual([...backward.independence]);
      count = forward.count;
      return body;
    };
    const observed = withWorldPipeline({ groupers: [(_frame, cluster) => ({ ...cluster, members: handles, resolution: "resolved" })], enrichers: [inspect] }, () => collectReadFrames(() => readWorldView(original.ctx, {
      operation: "concept", concept: original.ref, valid: { kind: "all" }, knownAt: { kind: "current" },
    })));
    const result = observed.result;
    if (!("result" in result) || result.result.status === "unavailable" || result.result.data.schema !== "kizuki.concept-card/v1") throw new Error("concept unavailable");
    expect(result.result.data.definitions.flatMap((r) => r.assessments.map((a) => a.independence)).sort()).toEqual(["dependent", "dependent", "independent"]);
    expect(count).toBe(2);
  } finally { db.close(); }
});

test("unknown and recorded transformation lineage never satisfy a two-root threshold", async () => {
  const f = await cardFixture();
  try {
    await f.write("concept.definition", { kind: "literal", value: "An uncertain account" }, { metadata: { lineage: { status: "unknown" } } });
    await f.write("concept.definition", { kind: "literal", value: "A generated account" }, { metadata: { generated_from: "synthetic:basis" } });
    const inspect: Enricher = (frame, body) => {
      const lineage = supportLineage(frame, body.claims.filter((c) => c.relation.predicate === "concept.definition").flatMap((c) => c.eligible.supports));
      expect(lineage.status).toBe("unknown");
      expect(lineage.count).toBe(1);
      expect(lineage.count >= 2).toBe(false);
      return body;
    };
    const card = withWorldPipeline({ enrichers: [inspect] }, () => f.card());
    expect(card.definitions.flatMap((r) => r.assessments.map((a) => a.independence)).sort()).toEqual(["dependent", "independent", "unknown"]);
  } finally { f.dispose(); }
});
