import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { worldSeed } from "../helpers/world-seed";
import { openLedger } from "../../src/ledger/db";
import { personFixture, ADA, BEN, PERSON_WHEN } from "../helpers/person-fixture";

const design = JSON.parse(readFileSync(new URL("../../../../rfcs/fixtures/world-perspective-binding-design.json", import.meta.url), "utf8"));

test("world-perspective-binding-design preserves C1 speakers, independent C2 and knowledge before correction", async () => {
  const f = await personFixture();
  try {
    for (const id of ["x_c1", "x_c2"])
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject: id });
    const actors: Record<string, string> = { "base:actor_ada": ADA, "base:actor_ben": BEN };
    for (const p of design.perspectives) await f.write("situation.commitment", { kind: "literal", value: p.deadline }, {
      subject: "x_c1", holder: actors[p.holder_ref], speaker: actors[p.speaker_ref], mode: p.confirmed ? "reported" : "uncertain",
      context: [ADA], text: `Source ${p.evidence_ref} records ${p.deadline}.`,
    });
    await f.write("situation.commitment", { kind: "literal", value: "Independent C2" }, { subject: "x_c2", context: [ADA] });
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    const before = f.readPerson(), snapshot: any = serveWorldView(f.ctx, {
      operation: "person", person: f.personRef, valid: { kind: "all" }, knownAt: { kind: "time", at: "9998-01-01T00:00:00.000Z" },
    }).data;
    const old = snapshot.result.data.knownAt;
    const c2 = before.perspectives.flatMap(p => p.relations).find(r => r.object.kind === "literal" && r.object.value === "Independent C2")!;
    for (const p of design.perspectives) {
      const speaker = f.findPerson(p.speaker_ref.endsWith("ada") ? "Ada" : "Ben");
      const group = before.perspectives.find(g => g.speaker?.token === speaker.token && g.holder?.token === speaker.token)!;
      expect(group.mode).toBe(p.confirmed ? "reported" : "uncertain");
      expect(group.relations.some(r => r.object.kind === "literal" && r.object.value === p.deadline)).toBe(true);
    }
    expect(before.agreedDeadline).toBe(design.oracle.agreed_deadline);
    await serveCorrect(f.ctx, { statement: "My corrected belief is that Ada is the editor.", target: { world_claim: before.roles[0]!.claim },
      mode: "replace_object", object: { kind: "literal", value: "Editor" } });
    const after = f.readPerson(), historical = f.readPerson(f.ctx, { ...PERSON_WHEN, knownAt: old });
    const c2After = after.perspectives.flatMap(p => p.relations).find(r => r.claim.token === c2.claim.token);
    expect(JSON.stringify(c2After) !== JSON.stringify(c2)).toBe(design.oracle.c2_affected);
    expect(historical.roles.some(r => r.object.kind === "literal" && r.object.value === "Editor")).toBe(design.oracle.later_correction_in_old_knowledge);
    expect(after.roles.some(r => r.object.kind === "literal" && r.object.value === "Editor")).toBe(true);
  } finally { f.dispose(); }
}, 120_000);

test("rich-subject-quoted-disagreement text alone cannot invent a Person or owner identity", async () => {
  const markdown = readFileSync(new URL("../../../../rfcs/0003-rich-subject-foundation.md", import.meta.url), "utf8");
  const marked = markdown.slice(markdown.indexOf("<!-- rich-subject-quoted-disagreement-example -->"));
  const example = JSON.parse(marked.match(/```json\n([\s\S]*?)\n```/)![1]!);
  expect(example.input.supplied_refs).toEqual([]);
  const db = openLedger(":memory:");
  try {
    for (const person of example.expected.discoveries) {
      const result = await worldSeed(db, { kind: "person", subject: person.occurrence_id, label: person.label,
        occurrence: true, discover: false }).catch(error => error);
      expect(result.cause?.code).toBe("world_endpoint_kind");
    }
    expect(db.query("SELECT count(*) AS n FROM semantic_bindings").get()).toEqual({ n: 0 });
  } finally { db.close(); }
}, 120_000);


test("rich-subject-quoted-disagreement preserves source statements after structured identities are supplied", async () => {
  const markdown = readFileSync(new URL("../../../../rfcs/0003-rich-subject-foundation.md", import.meta.url), "utf8");
  const example = JSON.parse(markdown.slice(markdown.indexOf("<!-- rich-subject-quoted-disagreement-example -->")).match(/```json\n([\s\S]*?)\n```/)![1]!);
  const f = await personFixture();
  try {
    // Separate positive control: the connector supplies identities. The original
    // source-only record above still cannot manufacture either Person.
    const quoted = example.expected.observations.find((o: any) => o.mode === "quotation");
    const disagreement = example.expected.observations.find((o: any) => o.mode === "disagreement");
    const quote = await f.write("concept.example", { kind: "literal", value: quoted.proposition }, {
      speaker: BEN, holder: BEN, mode: "quoted", context: [ADA], text: example.input.text,
      span: { start: quoted.anchor.start_utf16, end: quoted.anchor.end_utf16 },
    });
    await f.write("concept.example", { kind: "literal", value: quoted.proposition }, {
      speaker: ADA, holder: ADA, mode: "asserted", polarity: "negative", context: [ADA], text: example.input.text,
      span: { start: disagreement.anchor.start_utf16, end: disagreement.anchor.end_utf16 },
    });
    const relations = f.readPerson().perspectives.flatMap(p => p.relations).filter(r => r.predicate === "concept.example");
    expect(relations).toHaveLength(2);
    const quotation = relations.find(r => r.perspective.mode === "quoted")!;
    expect(quotation.perspective.speaker).toEqual(f.findPerson("Ben"));
    expect(quotation.polarity).toBe("positive");
    const negative = relations.find(r => r.polarity === "negative")!;
    expect(negative.perspective.speaker).toEqual(f.personRef);
    expect(relations.some(r => r.assessments.some(a => a.epistemicKind === "owner_assertion"))).toBe(quoted.endorsed_by_owner);
    expect(relations.some(r => r.object.kind === "literal" && /dislike/i.test(r.object.value))).toBe(disagreement.universal_dislike);
    const evidence = quotation.assessments.flatMap(a => a.evidence)[0]!;
    const expanded = serveWorldView(f.ctx, { operation: "evidence", evidence, ...PERSON_WHEN });
    expect(expanded.quoted[0]?.text).toBe(quote.event.text.slice(quoted.anchor.start_utf16, quoted.anchor.end_utf16));
    expect(evidence.span).toEqual({ kind: "text", startUtf16: quoted.anchor.start_utf16, endUtf16: quoted.anchor.end_utf16 });
  } finally { f.dispose(); }
}, 120_000);
