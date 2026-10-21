import {
  validateConceptCard,
  type ConceptCard,
} from "../../contracts/concept-card";
import { sealCard, type KindAssembler } from "./kit";

export const conceptAssembler: KindAssembler = {
  kind: "concept",
  assemble({ node, own, relations, summary, coverage }) {
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
      learning: relations
        .filter(
          (item) =>
            /^learning\.(exposure|explanation|application|demonstration)$/.test(
              item.predicate,
            ) &&
            item.object.kind === "node" &&
            item.object.ref.token === node.ref.token,
        )
        .map((item) => ({
          facet: item.predicate.slice(9) as
            | "exposure"
            | "explanation"
            | "application"
            | "demonstration",
          assertion: item,
          assistance: "unknown",
          assistanceEvidence: [],
        })),
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateConceptCard, "concept");
  },
};
