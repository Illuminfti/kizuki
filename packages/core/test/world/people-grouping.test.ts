import { expect, test } from "bun:test";
import { personFixture, ADA } from "../helpers/person-fixture";

test("a supplied Person cannot borrow Concept identity authority through a second classification", async () => {
  const f = await personFixture();
  try {
    expect(f.readPerson().person.resolution).toBe("distinct");
    await expect(f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, { subject: ADA }))
      .rejects.toThrow("world.kind subject is already classified as another kind");
    expect(f.readPerson().person.resolution).toBe("distinct");
  } finally { f.dispose(); }
}, 120_000);

test("existing learning evidence may mention a raw occurrence without classifying a Person", async () => {
  const { cardFixture } = await import("./card-fixture");
  const { mintOccurrenceId } = await import("../../src/claims/occurrences");
  const { insertClaim } = await import("../../src/claims/store");
  const { serveWorldView } = await import("../../src/serving/world-view");
  const f = await cardFixture();
  try {
    const anchor = { event_id: f.definition.event.event_id, start_utf16: 0, end_utf16: 8 };
    const subject = { kind: "occurrence" as const, id: mintOccurrenceId({ ...f.definition.event, accepted_at: "" }, f.sourceKey, anchor) };
    const semantic = { ...f.definition.semantic, subject, predicate: "learning.exposure", object: { kind: "subject" as const, ref: f.ref("topic:bayes") }, anchors: [anchor] };
    const body = "Captured learning exposure for an unresolved mention";
    const inserted = await insertClaim({ db: f.db }, { kind: "claim", body, provenance: [f.definition.event.event_id], producer: "deterministic",
      confidence: 0.8, sensitivity: "public", subjects: ["topic:bayes"], semantic,
      world_admission: { schema: "kizuki.world-admission/v1", semantic, rendering: { body, frontmatter: {} }, authority: "model_inference", confidence: 0.5, epistemicKind: "model_inference" } });
    expect(inserted.outcome).toBe("stored");
    const people: any = serveWorldView(f.ctx, { operation: "find_people", valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
    expect(people.result.data.matches).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);
