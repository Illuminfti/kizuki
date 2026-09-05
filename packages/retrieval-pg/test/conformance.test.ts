import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);
import { afterEach, describe, expect, test } from "bun:test";
import {
  PortError,
  PortRegistry,
  runRetrievalConformance,
} from "@kizuki/core";
import type {
  RetrievalConformanceHarness,
  RetrievalDoc,
  RetrievalPort,
} from "@kizuki/core";
import {
  EMBEDDED_RETRIEVAL_DESCRIPTOR,
  EMBEDDED_RETRIEVAL_ID,
  createEmbeddedRetrievalPort,
  registerEmbeddedRetrieval,
} from "../src/index";
import {
  FixtureEmbeddingPort,
  RETRIEVAL_FIXTURES,
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  temporaryPortContext,
} from "./helpers";

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function openPort(embedding?: FixtureEmbeddingPort): Promise<{
  port: RetrievalPort;
  cleanup: () => Promise<void>;
}> {
  const temporary = temporaryPortContext();
  const port = await createEmbeddedRetrievalPort(temporary.ctx, {
    ...(embedding === undefined ? {} : { embedding }),
  });
  const cleanup = async () => {
    await port.close();
    temporary.cleanup();
  };
  disposers.push(cleanup);
  return { port, cleanup };
}

function harness(): RetrievalConformanceHarness {
  return {
    descriptor: EMBEDDED_RETRIEVAL_DESCRIPTOR,
    create: async (ctx) => createEmbeddedRetrievalPort(ctx, { embedding: new FixtureEmbeddingPort() }),
    destroy: async (port) => port.close(),
    fixtures: RETRIEVAL_FIXTURES,
  };
}

const PRIVATE_CORRECTION: RetrievalDoc = {
  doc_id: "page:private-correction",
  kind: "page",
  title: "Private correction",
  text: "partnerships secret correction only",
  sensitivity: "private",
  taint: "clean",
  authority: "owner_correction",
  subjects: ["person:grace"],
  provenance: ["event:correction"],
  occurred_at: "2026-08-16T09:00:00.000Z",
  updated_at: "2026-09-02T12:00:00.000Z",
};

describe("kizuki.retrieval.embedded-pg conformance", () => {
  test("bound capabilities advertise vector nomination only with an embedding port", async () => {
    const lexical = await openPort();
    expect(lexical.port.descriptor.supports).toEqual(["lexical", "hybrid", "graph"]);
    expect((await lexical.port.health()).status).toBe("ready");
    const embedded = await openPort(new FixtureEmbeddingPort());
    expect(embedded.port.descriptor.supports).toEqual(EMBEDDED_RETRIEVAL_DESCRIPTOR.supports);
    expect(EMBEDDED_RETRIEVAL_DESCRIPTOR.supports).toContain("vector");
    expect(Object.isFrozen(lexical.port.descriptor)).toBe(true);
    expect(Object.isFrozen(lexical.port.descriptor.supports)).toBe(true);
    const registry = new PortRegistry();
    registerEmbeddedRetrieval(registry);
    const temporary = temporaryPortContext();
    const bound = await registry.bindFromConfig<RetrievalPort>("retrieval", { retrieval: EMBEDDED_RETRIEVAL_ID }, temporary.ctx);
    disposers.push(async () => { await bound.port.close(); temporary.cleanup(); });
    expect(bound.d.supports).toContain("vector");
    expect(bound.port.descriptor.supports).not.toContain("vector");
  });

  test("registers behind the retrieval port", () => {
    const registry = new PortRegistry();
    registerEmbeddedRetrieval(registry);
    expect(registry.listPorts("retrieval").map(({ id }) => id)).toContain(
      EMBEDDED_RETRIEVAL_ID,
    );
    expect(
      registry.listPorts("retrieval").find(({ id }) => id === EMBEDDED_RETRIEVAL_ID),
    ).toMatchObject({
      contract: "kizuki.retrieval/v1",
      supports: ["lexical", "vector", "hybrid", "graph"],
      requires_lease: true,
      optional_package: "@kizuki/retrieval-pg",
    });
  });

  test("passes retrieval conformance including golden recall", async () => {
    const report = await runRetrievalConformance(harness());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.families).toEqual({
      identity: "pass",
      isolation: "pass",
      idempotence: "pass",
      failure_shape: "pass",
      restart: "pass",
      deletion: "pass",
    });
  });

  test("applies the ceiling in the store and never widens", async () => {
    const { port } = await openPort();
    await port.upsert([...SYNTHETIC_DOCS, PRIVATE_CORRECTION]);

    const publicHits = await port.search({
      ...SYNTHETIC_QUERY,
      text: "partnerships",
      scope: {},
      ceiling: "public",
    });
    expect(publicHits.hits).toEqual([]);

    const personalHits = await port.search({
      ...SYNTHETIC_QUERY,
      text: "partnerships",
      scope: {},
      ceiling: "personal",
    });
    expect(personalHits.hits.map(({ doc_id }) => doc_id)).toEqual([
      "page:grace",
    ]);

    const missing = await port.search({
      ...SYNTHETIC_QUERY,
      scope: { subjects: ["conformance:missing"] },
      ceiling: "private",
    });
    expect(missing.hits).toEqual([]);
    expect(missing.degraded.includes("scope-empty")).toBe(false);

    const unlabeled = await port.search({
      ...SYNTHETIC_QUERY,
      text: "unlabeled",
      scope: {},
      ceiling: "private",
    });
    expect(unlabeled.hits.map(({ doc_id }) => doc_id)).not.toContain(
      "event:unlabeled",
    );
  });

  test("hybrid without an embedder declares vector-skipped", async () => {
    const { port } = await openPort();
    await port.upsert(SYNTHETIC_DOCS);
    const hybrid = await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" });
    expect(hybrid.degraded).toContain("vector-skipped");
    expect(hybrid.hits.map(({ doc_id }) => doc_id).sort()).toEqual([
      "claim:grace-email",
      "page:grace",
    ]);
  });

  test("vector mode without an embedder is unavailable, not empty", async () => {
    const { port } = await openPort();
    await port.upsert(SYNTHETIC_DOCS);
    try {
      await port.search({ ...SYNTHETIC_QUERY, mode: "vector" });
      throw new Error("expected PortError");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("unavailable");
    }
  });

  test("owner_correction outranks a stronger lexical model inference", async () => {
    const { port } = await openPort();
    await port.upsert([
      {
        ...SYNTHETIC_DOCS[0]!,
        doc_id: "page:inferred-partnerships",
        title: "Partnerships memo",
        text: "partnerships partnerships partnerships",
        authority: "model_inference",
        sensitivity: "personal",
      },
      {
        ...PRIVATE_CORRECTION,
        sensitivity: "personal",
        text: "partnerships correction",
      },
    ]);
    const ranked = await port.search({
      ...SYNTHETIC_QUERY,
      text: "partnerships",
      scope: {},
      ceiling: "personal",
    });
    expect(ranked.hits[0]?.doc_id).toBe("page:private-correction");
    expect(ranked.hits[0]?.authority).toBe("owner_correction");
  });

  test("hybrid with a fixture embedder fuses lexical and vector ranks", async () => {
    const { port } = await openPort(new FixtureEmbeddingPort());
    await port.upsert(SYNTHETIC_DOCS);
    const hybrid = await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" });
    expect(hybrid.degraded).not.toContain("vector-skipped");
    expect(hybrid.space).toBe("fixture:hash@8");
    expect(hybrid.hits.map(({ doc_id }) => doc_id).sort()).toEqual([
      "claim:grace-email",
      "page:grace",
    ]);
  });

  test("graph neighbors honor the ceiling and carry provenance", async () => {
    const { port } = await openPort();
    await port.upsert(SYNTHETIC_DOCS);
    const visible = await port.neighbors(
      { entity_id: "person:grace" },
      { hops: 1, limit: 10, ceiling: "private" },
    );
    expect(visible.entity).toBe("person:grace");
    expect(visible.edges.length).toBeGreaterThan(0);
    expect(visible.edges.every((edge) => edge.provenance.length > 0)).toBe(true);

    const publicOnly = await port.neighbors(
      { entity_id: "person:grace" },
      { hops: 1, limit: 10, ceiling: "public" },
    );
    expect(publicOnly.edges).toEqual([]);

    const twoHops = await port.neighbors(
      { entity_id: "person:grace" },
      { hops: 2, limit: 10, ceiling: "private" },
    );
    expect(twoHops.entity).toBe("person:grace");
    await expect(
      port.neighbors(
        { entity_id: "person:grace" },
        { hops: 3, limit: 10, ceiling: "private" },
      ),
    ).rejects.toMatchObject({ code: "config_invalid", retryable: false });
  });

  test("verifyAbsent is a real lookup", async () => {
    const { port } = await openPort();
    await port.upsert(SYNTHETIC_DOCS);
    const present = await port.verifyAbsent(["page:grace", "missing"]);
    expect(present.checked).toBe(2);
    expect(present.found).toEqual(["page:grace"]);
    await port.remove(["page:grace"]);
    const gone = await port.verifyAbsent(["page:grace"]);
    expect(gone.found).toEqual([]);
  });
});
