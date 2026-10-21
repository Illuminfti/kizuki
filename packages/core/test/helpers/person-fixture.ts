import type { Database } from "bun:sqlite";
import { serveWorldView } from "../../src/serving/world-view";
import { cardFixture } from "../world/card-fixture";

export const ADA = "person:ada", BEN = "person:ben";
export const PERSON_WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
export async function personFixture(database?: Database, options: Parameters<typeof cardFixture>[1] = {}) {
  const f = await cardFixture(database, options);
  try {
    for (const [id, label] of [[ADA, "Ada"], [BEN, "Ben"]] as const) {
      await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/person" } }, { subject: id });
      await f.write("person.label", { kind: "literal", value: label! }, { subject: id });
    }
    const findPerson = (label = "Ada", reader = f.ctx) => {
      const body = serveWorldView(reader, { operation: "find_people", label, ...PERSON_WHEN }).data;
      if (!("result" in body) || !("data" in body.result) || !("matches" in body.result.data)) throw new Error("person not discovered");
      return body.result.data.matches[0]!.ref;
    };
    const personRef = findPerson();
    const readPerson = (reader = f.ctx, when: Record<string, unknown> = PERSON_WHEN) => {
      const body = serveWorldView(reader, { operation: "person", person: findPerson("Ada", reader), ...when }).data;
      if (!("result" in body) || !("data" in body.result)) throw new Error("person unavailable");
      return body.result.data as import("../../src/contracts/person-card").PersonCard;
    };
    return { ...f, personRef, findPerson, readPerson };
  } catch (error) { f.dispose(); throw error; }
}
