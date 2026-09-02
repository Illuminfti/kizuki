import { describe, expect, test } from "bun:test";
import * as core from "../../src/index";

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
    ] as const) {
      expect(core).toHaveProperty(name);
    }

    expect(core.PORT_CONTRACTS).toEqual({
      retrieval: "kizuki.retrieval/v1",
      embedding: "kizuki.embedding/v1",
      llm: "kizuki.llm/v1",
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
