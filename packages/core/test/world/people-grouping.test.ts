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
