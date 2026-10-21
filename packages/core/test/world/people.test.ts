import { expect, test } from "bun:test";
import { serveCorrect } from "../../src/serving/correct";
import { worldSeed } from "../helpers/world-seed";
import { openLedger } from "../../src/ledger/db";
import { personFixture, ADA, BEN } from "../helpers/person-fixture";

test("structured people keep each speaker's attributed commitments without inventing agreement", async () => {
  const f = await personFixture();
  try {
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject: "commitment:c1" });
    await f.write("situation.label", { kind: "literal", value: "Release date" }, { subject: "commitment:c1" });
    for (const [speaker, deadline] of [[ADA, "Friday"], [BEN, "Thursday"]] as const) {
      await f.write("situation.commitment", { kind: "literal", value: deadline! }, {
        subject: "commitment:c1", speaker, mode: "quoted", context: [ADA],
        text: `${speaker} said the release date was ${deadline}.`,
      });
    }
    const card = f.readPerson();
    expect(card.schema).toBe("kizuki.person-card/v1");
    const groups = card.perspectives.filter(group => group.relations.some(relation => relation.predicate === "situation.commitment"));
    expect(groups).toHaveLength(2);
    const ada = f.findPerson("Ada"), ben = f.findPerson("Ben");
    expect(groups.find(group => group.speaker?.token === ada.token)?.relations[0]?.object).toEqual({ kind: "literal", value: "Friday" });
    expect(groups.find(group => group.speaker?.token === ben.token)?.relations[0]?.object).toEqual({ kind: "literal", value: "Thursday" });
    expect(card.agreedDeadline).toBeNull();
  } finally { f.dispose(); }
});

test("text occurrence evidence cannot create a person", async () => {
  const db = openLedger(":memory:");
  try {
    const failure = await worldSeed(db, { kind: "person", subject: "person:text-only", label: "Ada", occurrence: true, discover: false }).catch(error => error);
    expect(failure.cause?.code).toBe("world_endpoint_kind");
    expect(db.query("SELECT count(*) AS n FROM semantic_bindings").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("correcting an owner's belief preserves the other person's quoted statement", async () => {
  const f = await personFixture();
  try {
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    await f.write("person.role", { kind: "literal", value: "Author" }, { subject: ADA, speaker: BEN, mode: "quoted" });
    const before = f.readPerson();
    const belief = before.roles.find(relation => relation.perspective.speaker === null)!;
    const quotation = before.roles.find(relation => relation.perspective.speaker !== null)!;
    await serveCorrect(f.ctx, { statement: "I believe Ada is the editor.", target: { world_claim: belief.claim }, mode: "replace_object", object: { kind: "literal", value: "Editor" } });
    const after = f.readPerson();
    expect(after.roles.some(relation => relation.claim.token === quotation.claim.token && relation.object.kind === "literal" && relation.object.value === "Author")).toBe(true);
    expect(after.roles.find(relation => relation.object.kind === "literal" && relation.object.value === "Editor")?.assessments.some(item => item.epistemicKind === "owner_assertion")).toBe(true);
    expect(after.roles.some(relation => relation.claim.token === belief.claim.token)).toBe(false);
  } finally { f.dispose(); }
});
