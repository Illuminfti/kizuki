import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { purgeEvents } from "../../src/ledger/purge";
import { serveTimeline } from "../../src/serving/timeline";
import { conceptScenario } from "../helpers/world-kit/scenario";
import { cardFixture } from "./card-fixture";

test("world-concept-absence-design binds missing learning sections and a partial card to real reads", async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../../../rfcs/fixtures/world-concept-absence-design.json"), "utf8"));
  const f = await cardFixture();
  try {
    await f.write("learning.exposure", { kind: "subject", ref: f.ref("topic:bayes") }, { subject: "person:ada", context: ["task:one"] });
    setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "pending-coverage", policy: {
      purposes: ["capture", "derive", "recall", "correction", "export", "extract"], allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public",
    } });
    const card = f.card();
    expect(card.definitions.length > 0).toBe(fixture.card.definition_present);
    expect(card.learning.some((l) => l.facet === "application")).toBe(fixture.card.applications_present);
    for (const [facet, key] of [["exposure", "exposure"], ["explanation", "explanation"], ["application", "application"], ["demonstration", "demonstrated_performance"]] as const) {
      expect(card.learning.some((l) => l.facet === facet)).toBe(fixture.epistemic[key]);
    }
    expect(card).not.toHaveProperty("open_questions");
    expect(card.coverage.status).toBe(fixture.oracle.view_status);
    expect(card.learning.filter((l) => l.facet === "demonstration" && l.assistance === "unassisted")).toHaveLength(fixture.oracle.independent_performance_count);
  } finally { f.dispose(); }
});

test("world-concept-design#a_copy_raw_retained: purging the original source does not erase a separately captured raw copy", async () => {
  const scene = await conceptScenario();
  try {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../../../rfcs/fixtures/world-concept-design.json"), "utf8"));
    const expected = fixture.oracle.assertions.find((a: { id: string }) => a.id === "a_copy_raw_retained").expected;
    const source = fixture.input.controls.find((c: { id: string }) => c.id === "ctl_purge_s1");
    for (const record of source.selected_record_refs) purgeEvents(scene.db, scene.vaultPath, { event_id: scene.records.get(record)! }, `erase-${record}`);
    const copied = serveTimeline(scene.ctx("owner"), { event_id: scene.records.get(expected.raw_record_ref)! });
    expect(copied.quoted).toHaveLength(1);
    expect(copied.quoted[0]!.text).toContain(expected.content_contains);
    expect(serveTimeline(scene.ctx("owner"), { event_id: scene.records.get("r01")! }).quoted).toEqual([]);
  } finally { scene.dispose(); }
});
