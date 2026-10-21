import { validatePersonCard, type PersonCard, type PersonPerspective } from "../../contracts/person-card";
import { sealCard, type KindAssembler } from "./kit";
export const personAssembler: KindAssembler = {
  kind: "person",
  assemble({ node, own, relations, summary, coverage }) {
    const grouped = new Map<string, PersonPerspective>();
    for (const relation of relations) {
      if (relation.predicate === "world.kind" || relation.predicate === "person.label") continue;
      const { holder, speaker, mode } = relation.perspective;
      const key = JSON.stringify([holder?.token ?? null, speaker?.token ?? null, mode]);
      const prior = grouped.get(key);
      grouped.set(key, { holder, speaker, mode, relations: [...(prior?.relations ?? []), relation] });
    }
    const card: PersonCard = { schema: "kizuki.person-card/v1", person: { ...node, kind: "person" }, summary,
      roles: own.filter(item => item.predicate === "person.role"),
      relationships: relations.filter(item => item.predicate === "relationship.with"),
      perspectives: [...grouped.values()], agreedDeadline: null, knownAt: { kind: "current" }, coverage };
    return sealCard(card, validatePersonCard, "person");
  },
};
