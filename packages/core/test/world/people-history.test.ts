import { expect, test } from "bun:test";
import { validatePersonCard } from "../../src/contracts/person-card";
import { serveWorldView } from "../../src/serving/world-view";
import { serveCorrect } from "../../src/serving/correct";
import { purgeEvents } from "../../src/ledger/purge";
import { personFixture, ADA, BEN } from "../helpers/person-fixture";

test("relationship validity and recorded knowledge are distinct, and snapshots preserve attributed beliefs", async () => {
  const f = await personFixture();
  try {
    f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run("2030-01-09T00:00:00.000Z");
    await f.write("relationship.with", { kind: "subject", ref: f.ref(BEN) }, { subject: ADA, from: "2026-01-01T00:00:00.000Z", until: "2026-03-01T00:00:00.000Z" });
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA, holder: ADA, speaker: BEN, mode: "reported" });
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA });
    const valid = { kind: "at", at: "2026-02-01T00:00:00.000Z" };
    expect(f.readPerson(f.ctx, { valid, knownAt: { kind: "current" } }).relationships).toHaveLength(1);
    expect(f.readPerson(f.ctx, { valid: { kind: "at", at: "2026-04-01T00:00:00.000Z" }, knownAt: { kind: "current" } }).relationships).toEqual([]);
    expect(f.readPerson(f.ctx, { valid, knownAt: { kind: "time", at: "2030-01-08T00:00:00.000Z" } }).relationships).toEqual([]);
    const old = f.readPerson(f.ctx, { valid, knownAt: { kind: "time", at: "2030-01-09T00:00:00.000Z" } });
    expect(old.knownAt.kind).toBe("snapshot");
    expect(old.perspectives.find(group => group.mode === "reported")?.holder).toEqual(f.personRef);
    await serveCorrect(f.ctx, { statement: "I believe Ada is the editor.", target: { world_claim: old.roles.find(item => item.perspective.speaker === null)!.claim }, mode: "replace_object", object: { kind: "literal", value: "Editor" } });
    const replay = f.readPerson(f.ctx, { valid, knownAt: old.knownAt });
    expect(replay.roles.some(item => item.perspective.mode === "reported")).toBe(true);
    expect(replay.roles.every(item => item.object.kind !== "literal" || item.object.value === "Reviewer")).toBe(true);
    expect(replay.relationships).toHaveLength(1);
  } finally { f.dispose(); }
}, 120_000);

test("Person contracts reject merged perspectives, invented agreements and null discovery selectors", async () => {
  const f = await personFixture();
  try {
    await f.write("person.role", { kind: "literal", value: "Reviewer" }, { subject: ADA, holder: ADA, speaker: BEN, mode: "quoted" });
    const card = f.readPerson();
    expect(validatePersonCard(card).ok).toBe(true);
    expect(validatePersonCard({ ...card, agreedDeadline: "Friday" }).ok).toBe(false);
    expect(validatePersonCard({ ...card, perspectives: card.perspectives.map(group => ({ ...group, speaker: null })) }).ok).toBe(false);
    for (const selector of ["label", "cursor"]) expect(() => serveWorldView(f.ctx, { operation: "find_people", [selector]: null })).toThrow();
  } finally { f.dispose(); }
}, 120_000);

test("partial erasure of an attributed support invalidates its retained Person history", async () => {
  const f = await personFixture();
  try {
    const subject = "statement:release";
    await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, { subject });
    const one = await f.write("situation.commitment", { kind: "literal", value: "Friday" }, { subject, speaker: ADA, mode: "quoted" });
    await f.write("situation.commitment", { kind: "literal", value: "Friday" }, { subject, speaker: ADA, mode: "quoted" });
    const card = f.readPerson(f.ctx, { valid: { kind: "all" }, knownAt: { kind: "time", at: "2030-01-09T00:00:00.000Z" } });
    expect(card.perspectives.some(group => group.relations.some(item => item.predicate === "situation.commitment"))).toBe(true);
    purgeEvents(f.db, f.ctx.vaultPath, { event_id: one.event.event_id }, "person-partial-purge");
    const result = serveWorldView(f.ctx, { operation: "person", person: f.personRef, valid: { kind: "all" }, knownAt: card.knownAt });
    expect(result.data).toMatchObject({ result: { status: "new_view_required" } });
    expect(result.quoted).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);
