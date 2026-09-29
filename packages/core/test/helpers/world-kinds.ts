import { worldPredicate, type WorldKindSpec, type WorldVocabularyModule } from "../../src/contracts/world-kinds";

/** A synthetic kind module for a test registry: a label predicate and whatever rows the test adds. */
export function testKind(
  id: string,
  over: Partial<WorldKindSpec> = {},
  extra: readonly ReturnType<typeof worldPredicate>[] = [],
): WorldVocabularyModule {
  return {
    kind: {
      id, vocabularyId: `world/${id}`, labelPredicate: `${id}.label`, pageType: "topic", endpointKind: "concept",
      cardSchema: `kizuki.${id}-card/v1`, offeredToProducer: false, population: ["extraction"], ...over,
    },
    predicates: [worldPredicate({ predicate: `${id}.label`, subject: "concept", objects: ["literal"] }), ...extra],
  };
}
