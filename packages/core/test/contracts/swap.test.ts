import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { PortContext } from "../../src/contracts/ports";
import { PortRegistry } from "../../src/contracts/registry";
import type { RetrievalPort } from "../../src/contracts/retrieval";
import {
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  temporaryPortContext,
} from "./fixtures";
import type {
  RemoteRetrievalFixture,
} from "./remote-fixture";
import {
  startRemoteRetrievalFixture,
} from "./remote-fixture";
import {
  DIRECT_RETRIEVAL_DESCRIPTOR,
  ReferenceRetrievalPort,
} from "./reference-retrieval";

interface WorkedExampleResult {
  canon_bytes: string;
  receipt: {
    claim_ids: string[];
    page_path: string;
    before_hash: null;
    writer: "loop";
    provenance: string[];
    retrieval_recall: string[];
  };
}

async function workedExample(
  retrieval: RetrievalPort,
): Promise<WorkedExampleResult> {
  await retrieval.upsert(SYNTHETIC_DOCS);
  const result = await retrieval.search(SYNTHETIC_QUERY);
  const recall = result.hits.map(({ doc_id }) => doc_id).sort();
  expect(recall).toEqual(["claim:grace-email", "page:grace"]);

  return {
    canon_bytes: [
      "---",
      "id: grace",
      "type: person",
      "sensitivity: private",
      "taint: clean",
      "sources: [event:acme-note]",
      "---",
      "Grace runs partnerships at Acme.",
      "",
    ].join("\n"),
    receipt: {
      claim_ids: ["claim:grace-email"],
      page_path: "people/grace.md",
      before_hash: null,
      writer: "loop",
      provenance: ["event:acme-note"],
      retrieval_recall: recall,
    },
  };
}

describe("port swap invariance", () => {
  let remote: RemoteRetrievalFixture;

  beforeAll(async () => {
    remote = await startRemoteRetrievalFixture();
  });

  afterAll(async () => {
    await remote.stop();
  });

  async function runBoth(): Promise<WorkedExampleResult[]> {
    const directContext = temporaryPortContext(
      DIRECT_RETRIEVAL_DESCRIPTOR,
    );
    const remoteContext = temporaryPortContext(remote.descriptor);
    let remotePort: RetrievalPort | undefined;
    let directPort: RetrievalPort | undefined;
    try {
      remotePort = await remote.create(remoteContext.ctx);
      const registry = new PortRegistry();
      registry.registerPort(
        DIRECT_RETRIEVAL_DESCRIPTOR,
        (ctx: PortContext) => new ReferenceRetrievalPort(ctx),
      );
      registry.registerPort(remote.descriptor, () => remotePort!);

      directPort = (await registry.bindFromConfig<RetrievalPort>(
        "retrieval",
        { retrieval: DIRECT_RETRIEVAL_DESCRIPTOR.id },
        directContext.ctx,
      )).port;
      const selectedRemote = (await registry.bindFromConfig<RetrievalPort>(
        "retrieval",
        { retrieval: remote.descriptor.id },
        remoteContext.ctx,
      )).port;

      return [
        await workedExample(directPort),
        await workedExample(selectedRemote),
      ];
    } finally {
      await directPort?.close();
      await remotePort?.close();
      directContext.cleanup();
      remoteContext.cleanup();
    }
  }

  test("the worked example produces identical canon bytes under every retrieval implementation", async () => {
    const results = await runBoth();
    expect(new Set(results.map(({ canon_bytes }) => canon_bytes)).size).toBe(1);
  });

  test("the worked example produces identical receipts under every retrieval implementation", async () => {
    const results = await runBoth();
    expect(new Set(results.map(({ receipt }) => JSON.stringify(receipt))).size)
      .toBe(1);
  });
});
