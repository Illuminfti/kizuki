import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";
import type { WorldReadInput, WorldValidQuery, WorldKnownAt, ViewToken } from "@kizuki/core/world";

// Compile-time public API regression: each literal remains independently extractable.
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type LabelDiscovery<Operation extends string> = {
  readonly operation: Operation; readonly label?: string; readonly cursor?: string;
  readonly valid: WorldValidQuery;
  readonly knownAt: WorldKnownAt;
  readonly priorView?: ViewToken;
};
type DiscoveryInputCompatibility = [
  Assert<Equal<Extract<WorldReadInput, { operation: "find_people" }>, LabelDiscovery<"find_people">>>,
  Assert<Equal<Extract<WorldReadInput, { operation: "find_skills" }>, LabelDiscovery<"find_skills">>>,
  Assert<Equal<Extract<WorldReadInput, { operation: "find_frameworks" }>, LabelDiscovery<"find_frameworks">>>,
];

describe("public port surface", () => {
  test("exports the registry, contracts, conformance, and remote adapter", () => {
    for (const name of [
      "PortError",
      "PortRegistry",
      "bindFromConfig",
      "connectRemotePort",
      "createFts5RetrievalPort",
      "createModelProducerPort",
      "createRemoteRetrievalPort",
      "listPorts",
      "registerModelProducerPort",
      "registerPort",
      "resolvePort",
      "runEmbeddingConformance",
      "runLlmConformance",
      "runNotifierConformance",
      "runProducerConformance",
      "runRetrievalConformance",
      "runStorageConformance",
      "runSurfaceConformance",
      "runSystemOneConformance",
    ] as const) {
      expect(core).toHaveProperty(name);
    }

    expect(core.PORT_CONTRACTS).toEqual({
      retrieval: "kizuki.retrieval/v1",
      embedding: "kizuki.embedding/v1",
      llm: "kizuki.llm/v1",
      systemone: "kizuki.systemone/v1",
      producer: "kizuki.producer/v1",
      connector: "kizuki.connector/v1",
      notifier: "kizuki.notifier/v1",
      "ledger-store": "kizuki.ledger-store/v1",
      "canon-store": "kizuki.canon-store/v1",
      "journal-store": "kizuki.journal-store/v1",
      surface: "kizuki.surface/v1",
    });
  });
});
