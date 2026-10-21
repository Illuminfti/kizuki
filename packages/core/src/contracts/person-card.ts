import { isPlainObject } from "../util/validate";
import {
  cardCodec, coverage, exact, knownAt, knowledgeNode, relationList, summary, wireRef,
  type CardKnownAt, type CardSummary, type Coverage, type KnowledgeNode, type Perspective, type Relation, type WorldWireRef,
} from "./world-card-kit";

export const PERSON_CARD_SCHEMA = "kizuki.person-card/v1" as const;
export interface PersonPerspective {
  readonly holder: WorldWireRef<"object"> | null;
  readonly speaker: WorldWireRef<"object"> | null;
  readonly mode: Perspective["mode"];
  readonly relations: readonly Relation[];
}
export type PersonCard = {
  readonly schema: typeof PERSON_CARD_SCHEMA;
  readonly person: KnowledgeNode<"person">;
  readonly summary: CardSummary | null;
  readonly roles: readonly Relation[];
  readonly relationships: readonly Relation[];
  readonly perspectives: readonly PersonPerspective[];
  /** Separate statements are not evidence of an agreement. */
  readonly agreedDeadline: null;
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
}
const ref = (value: unknown) => value === null || wireRef(value, "object");
const key = (value: WorldWireRef<"object"> | null) => value?.token ?? null;
function perspectives(value: unknown): value is readonly PersonPerspective[] {
  return Array.isArray(value) && value.length <= 256 && value.every(group => {
    if (!isPlainObject(group) || !exact(group, ["holder", "speaker", "mode", "relations"]) ||
        !ref(group.holder) || !ref(group.speaker) || !relationList(group.relations) || group.relations.length === 0) return false;
    return group.relations.every(relation => relation.perspective.mode === group.mode &&
      key(relation.perspective.holder) === key(group.holder as PersonPerspective["holder"]) &&
      key(relation.perspective.speaker) === key(group.speaker as PersonPerspective["speaker"]));
  });
}
export const validatePersonCard = cardCodec<PersonCard, "person-card">({
  schema: PERSON_CARD_SCHEMA, label: "person-card", fields: {
    person: value => knowledgeNode(value, "person"), summary, roles: relationList, relationships: relationList,
    perspectives, agreedDeadline: value => value === null, knownAt, coverage,
  },
});
