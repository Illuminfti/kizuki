import {
  validateConceptCard,
  type ConceptCard,
} from "../../contracts/concept-card";
import { sealCard, type KindAssembler } from "./kit";

export const conceptAssembler: KindAssembler = {
  kind: "concept",
  assemble({ node, own, learning, summary, coverage }) {
    const card: ConceptCard = {
      schema: "kizuki.concept-card/v1",
      concept: { ...node, kind: "concept" },
      summary,
      definitions: own.filter(
        (item) => item.predicate === "concept.definition",
      ),
      relations: own.filter(
        (item) =>
          item.predicate !== "concept.definition" &&
          item.predicate !== "concept.label" &&
          item.predicate !== "world.kind",
      ),
      learning: learning.filter((item) => item.assertion.object.kind === "node" && item.assertion.object.ref.token === node.ref.token),
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateConceptCard, "concept");
  },
};
