import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runRetrievalConformance } from "../../src/contracts/conformance/retrieval";
import type { RetrievalConformanceHarness } from "../../src/contracts/conformance/retrieval";
import { PortError } from "../../src/contracts/ports";
import { validateRetrievalDoc } from "../../src/contracts/retrieval";
import type { PortContext } from "../../src/contracts/ports";
import { listPorts } from "../../src/contracts/registry";
import type { RetrievalDoc, RetrievalPort } from "../../src/contracts/retrieval";
import {
  FTS5_RETRIEVAL_DESCRIPTOR,
  FTS5_RETRIEVAL_ENGINE_REL,
  FTS5_RETRIEVAL_ID,
  FTS5_RETRIEVAL_STORE_REL,
  createFts5RetrievalPort,
} from "../../src/retrieval";
import {
  RETRIEVAL_FIXTURES,
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  temporaryPortContext,
} from "../contracts/fixtures";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function openPort(): { port: RetrievalPort; ctx: PortContext } {
  const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
  disposers.push(temporary.cleanup);
  const port = createFts5RetrievalPort(temporary.ctx);
  disposers.push(() => {
    void port.close();
  });
  return { port, ctx: temporary.ctx };
}

function harness(): RetrievalConformanceHarness {
  return {
    descriptor: FTS5_RETRIEVAL_DESCRIPTOR,
    create: async (ctx) => createFts5RetrievalPort(ctx),
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

describe("kizuki.retrieval.fts5", () => {
  test("is registered as the default retrieval port", () => {
    const listed = listPorts("retrieval");
    expect(listed.map(({ id }) => id)).toContain(FTS5_RETRIEVAL_ID);
    expect(
      listed.find(({ id }) => id === FTS5_RETRIEVAL_ID),
    ).toMatchObject({
      contract: "kizuki.retrieval/v1",
      supports: ["lexical"],
      requires_lease: true,
      optional_package: null,
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

  test("retrieves matching pages and claims from FTS5", async () => {
    const { port } = openPort();
    await port.upsert(SYNTHETIC_DOCS);

    const byName = await port.search(SYNTHETIC_QUERY);
    expect(byName.hits.map(({ doc_id }) => doc_id).sort()).toEqual([
      "claim:grace-email",
      "page:grace",
    ]);
    expect(byName.space).toBeNull();
    expect(byName.degraded).toEqual([]);

    const byBody = await port.search({
      ...SYNTHETIC_QUERY,
      text: "partnerships",
      scope: {},
    });
    expect(byBody.hits.map(({ doc_id }) => doc_id)).toEqual(["page:grace"]);
    expect(byBody.hits[0]?.snippet).toContain("partnerships");

    const byClaim = await port.search({
      ...SYNTHETIC_QUERY,
      text: "grace@acme.test",
      scope: { kinds: ["claim"] },
    });
    expect(byClaim.hits.map(({ doc_id }) => doc_id)).toEqual([
      "claim:grace-email",
    ]);
  });

  test("applies the ceiling in the store and never widens", async () => {
    const { port } = openPort();
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

    const missingSubject = await port.search({
      ...SYNTHETIC_QUERY,
      scope: { subjects: ["conformance:missing"] },
      ceiling: "private",
    });
    expect(missingSubject.hits).toEqual([]);

    const emptyKinds = await port.search({
      ...SYNTHETIC_QUERY,
      scope: { kinds: [] },
    });
    expect(emptyKinds.hits).toEqual([]);
    expect(emptyKinds.degraded).toContain("scope-empty");
  });

  test("never serves an unlabeled document at any ceiling", async () => {
    const { port } = openPort();
    await port.upsert(SYNTHETIC_DOCS);

    for (const ceiling of ["public", "personal", "private"] as const) {
      const result = await port.search({
        text: "unlabeled",
        mode: "lexical",
        scope: {},
        ceiling,
        limit: 10,
        deadline_ms: 1_000,
      });
      expect(result.hits.map(({ doc_id }) => doc_id)).not.toContain(
        "event:unlabeled",
      );
    }
  });

  test("vector is not_supported and hybrid degrades to lexical", async () => {
    const { port } = openPort();
    await port.upsert(SYNTHETIC_DOCS);

    try {
      await port.search({ ...SYNTHETIC_QUERY, mode: "vector" });
      throw new Error("expected PortError");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("not_supported");
      expect((error as PortError).retryable).toBe(false);
    }

    const hybrid = await port.search({
      ...SYNTHETIC_QUERY,
      mode: "hybrid",
    });
    expect(hybrid.degraded).toEqual(["vector-skipped"]);
    expect(hybrid.hits.map(({ doc_id }) => doc_id).sort()).toEqual([
      "claim:grace-email",
      "page:grace",
    ]);
  });

  test("verifyAbsent is a real store lookup", async () => {
    const { port } = openPort();
    await port.upsert(SYNTHETIC_DOCS);

    const present = await port.verifyAbsent(["page:grace", "missing:doc"]);
    expect(present.checked).toBe(2);
    expect(present.found).toEqual(["page:grace"]);
    expect(present.store).toBe(FTS5_RETRIEVAL_ID);
    expect(present.method).toBe("lookup-limit-100");

    await port.remove(["page:grace"]);
    const absent = await port.verifyAbsent(["page:grace"]);
    expect(absent.found).toEqual([]);
  });

  test("persists under the port data dir and survives restart", async () => {
    const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
    disposers.push(temporary.cleanup);

    const first = createFts5RetrievalPort(temporary.ctx);
    await first.upsert(SYNTHETIC_DOCS);
    await first.close();

    expect(
      existsSync(join(temporary.ctx.data_dir, FTS5_RETRIEVAL_STORE_REL)),
    ).toBe(true);
    const engine = JSON.parse(
      readFileSync(
        join(temporary.ctx.data_dir, FTS5_RETRIEVAL_ENGINE_REL),
        "utf8",
      ),
    ) as { port: string; space: string | null };
    expect(engine.port).toBe(FTS5_RETRIEVAL_ID);
    expect(engine.space).toBeNull();

    const second = createFts5RetrievalPort(temporary.ctx);
    disposers.push(() => {
      void second.close();
    });
    const result = await second.search(SYNTHETIC_QUERY);
    expect(result.hits.map(({ doc_id }) => doc_id).sort()).toEqual([
      "claim:grace-email",
      "page:grace",
    ]);
  });

  test("opening a pre-companion store keeps existing documents", async () => {
    const temporary = temporaryPortContext(FTS5_RETRIEVAL_DESCRIPTOR);
    disposers.push(temporary.cleanup);
    mkdirSync(join(temporary.ctx.data_dir, "store"), { recursive: true, mode: 0o700 });
    const legacy = new Database(join(temporary.ctx.data_dir, FTS5_RETRIEVAL_STORE_REL));
    legacy.exec(`
      CREATE VIRTUAL TABLE search_docs USING fts5(
        doc_id UNINDEXED,
        kind UNINDEXED,
        title,
        text,
        sensitivity UNINDEXED,
        taint UNINDEXED,
        authority UNINDEXED,
        subjects UNINDEXED,
        provenance UNINDEXED,
        occurred_at UNINDEXED,
        updated_at UNINDEXED
      );
    `);
    const grace = SYNTHETIC_DOCS[0]!;
    legacy
      .query(
        `INSERT INTO search_docs (
           doc_id, kind, title, text, sensitivity, taint, authority,
           subjects, provenance, occurred_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grace.doc_id,
        grace.kind,
        grace.title,
        grace.text,
        grace.sensitivity ?? "unlabeled",
        grace.taint,
        grace.authority,
        JSON.stringify(grace.subjects),
        JSON.stringify(grace.provenance),
        grace.occurred_at ?? "",
        grace.updated_at,
      );
    legacy.close();

    const port = createFts5RetrievalPort(temporary.ctx);
    disposers.push(() => {
      void port.close();
    });
    const result = await port.search({
      ...SYNTHETIC_QUERY,
      text: "partnerships",
      scope: {},
    });
    expect(result.hits.map(({ doc_id }) => doc_id)).toEqual(["page:grace"]);
  });

  test("rejects a bare document id", () => {
    expect(() =>
      validateRetrievalDoc({
        ...SYNTHETIC_DOCS[0],
        doc_id: "grace",
      }),
    ).toThrow(PortError);
  });

  test("upsert replaces by primary key instead of duplicating", async () => {
    const { port, ctx } = openPort();
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    await port.upsert([
      { ...SYNTHETIC_DOCS[0]!, title: "Grace revised", text: "Grace runs partnerships at Acme." },
    ]);
    const db = new Database(join(ctx.data_dir, FTS5_RETRIEVAL_STORE_REL));
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM search_documents WHERE doc_id = 'page:grace'",
        )
        .get()?.count,
    ).toBe(1);
    db.close();
    const result = await port.search({
      ...SYNTHETIC_QUERY,
      text: "revised",
      scope: {},
    });
    expect(result.hits.map(({ doc_id }) => doc_id)).toEqual(["page:grace"]);
  });
});

test("FTS atomic rebuild preserves old documents on source failure and accepts unknown update dates", async () => {
  const { port } = openPort();
  const original = { ...SYNTHETIC_DOCS[0]!, updated_at: null };
  await port.upsert([original]);
  const before = (await port.search(SYNTHETIC_QUERY)).hits;
  async function* failing() {
    yield { ...original, doc_id: "page:replacement" };
    throw new Error("synthetic source failure");
  }
  await expect(port.rebuildFromDocuments!(failing())).rejects.toThrow("synthetic source failure");
  expect((await port.search(SYNTHETIC_QUERY)).hits).toEqual(before);
  await port.rebuildFromDocuments!([original]);
  expect((await port.search(SYNTHETIC_QUERY)).hits).toEqual(before);
});
