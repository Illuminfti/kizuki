import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PortError, readRetrievalEngineRefusal } from "@kizuki/core";
import type { Chunk, RetrievalDoc } from "@kizuki/core";
import { openEmbeddedRetrievalPort } from "../src/index";
import type { EmbeddedRetrievalPort } from "../src/index";
import { chunkDocument } from "../src/store";
import {
  FIXTURE_SPACE,
  FixtureEmbeddingPort,
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  temporaryPortContext,
} from "./helpers";

// Each test opens an embedded SQL engine; bound them for a loaded host.
setDefaultTimeout(120_000);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Records what the engine hands the embedder. */
class RecordingEmbedding extends FixtureEmbeddingPort {
  readonly chunks: Chunk[] = [];
  failQueries = false;
  override async embedQuery(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.failQueries)
      throw new PortError(
        "unavailable",
        "embedding server is unreachable",
        true,
      );
    return super.embedQuery(texts);
  }
  override async embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    this.chunks.push(...chunks);
    return super.embedDocs(chunks);
  }
}

async function open(
  embedding?: RecordingEmbedding,
  options: { chunk_tokens?: number; chunk_overlap?: number; max_text_bytes?: number } = {},
) {
  const temporary = temporaryPortContext();
  cleanups.push(temporary.cleanup);
  const port = await openEmbeddedRetrievalPort(temporary.ctx, {
    ...(embedding === undefined ? {} : { embedding }),
    ...options,
  });
  cleanups.unshift(() => port.close());
  return { temporary, port };
}

function doc(id: string, text: string, title = `Title of ${id}`): RetrievalDoc {
  return {
    ...SYNTHETIC_DOCS[0]!,
    doc_id: id,
    title,
    text,
    subjects: ["person:grace"],
  };
}

const words = (count: number, prefix = "w") =>
  Array.from({ length: count }, (_, at) => `${prefix}${at}`).join(" ");

async function chunkRows(
  port: EmbeddedRetrievalPort,
): Promise<
  Array<{ chunk_id: string; body: string; embedding: string | null }>
> {
  const store = (
    port as unknown as {
      store: { db: { query<T>(sql: string): Promise<{ rows: T[] }> } };
    }
  ).store;
  return (
    await store.db.query<{
      chunk_id: string;
      body: string;
      embedding: string | null;
    }>(
      "SELECT chunk_id, body, embedding::text AS embedding FROM retrieval_chunks ORDER BY chunk_id",
    )
  ).rows;
}

describe("chunking follows the embedder's tokenizer", () => {
  const base = doc("page:a", "");

  test("without a tokenizer the size is counted in words, exactly as before", () => {
    const chunks = chunkDocument(
      { ...base, text: "one two three four five six seven" },
      3,
      1,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "one two three",
      "three four five",
      "five six seven",
    ]);
    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "page:a#0",
      "page:a#1",
      "page:a#2",
    ]);
  });

  test("the title is not part of a chunk", () => {
    const chunks = chunkDocument(
      { ...base, title: "Quarterly plan", text: "alpha beta" },
      8,
      2,
    );
    expect(chunks.map((chunk) => chunk.text)).toEqual(["alpha beta"]);
    expect(
      chunkDocument({ ...base, title: "Only a title", text: "" }, 8, 2).map(
        (chunk) => chunk.text,
      ),
    ).toEqual([""]);
  });

  test("a token counter changes where chunks end, and no chunk exceeds the budget", () => {
    const count = (text: string) => text.length; // one token per character
    const text =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const chunks = chunkDocument({ ...base, text }, 12, 5, count);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      const used = chunk.text
        .split(" ")
        .reduce((sum, word) => sum + count(word), 0);
      expect(used).toBeLessThanOrEqual(12);
    }
    // Overlap re-reads a short tail of the previous chunk, never more than the overlap budget.
    const overlaps = chunks.slice(1).map((chunk, at) => {
      const previous = chunks[at]!.text.split(" ");
      const carried = chunk.text.split(" ").filter((word, index) => index < previous.length && previous.includes(word));
      return carried.reduce((sum, word) => sum + count(word), 0);
    });
    expect(Math.max(...overlaps)).toBeGreaterThan(0);
    expect(Math.max(...overlaps)).toBeLessThanOrEqual(5);
    expect(new Set(chunks.flatMap((chunk) => chunk.text.split(" ")))).toEqual(
      new Set(text.split(" ")),
    );
  });

  test("a run with no whitespace is cut to fit instead of exceeding the window", () => {
    const blob = "x".repeat(50);
    const chunks = chunkDocument(
      { ...base, text: `see ${blob} now` },
      10,
      2,
      (text) => text.length,
    );
    for (const chunk of chunks) {
      expect(
        chunk.text.split(" ").reduce((sum, word) => sum + word.length, 0),
      ).toBeLessThanOrEqual(10);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toContain(
      "x".repeat(10),
    );
  });
});

describe("the engine embeds with the title, never the id", () => {
  test("every chunk carries its document title and only its body text", async () => {
    const embedding = new RecordingEmbedding();
    const { port } = await open(embedding);
    await port.upsert([
      doc("page:grace", "Grace runs partnerships at Acme.", "Grace at Acme"),
    ]);
    expect(embedding.chunks).toHaveLength(1);
    expect(embedding.chunks[0]).toMatchObject({
      doc_id: "page:grace",
      title: "Grace at Acme",
      text: "Grace runs partnerships at Acme.",
    });
  });
});

describe("hybrid search never depends on the embedding server", () => {
  test("a dead embedder leaves lexical answers with a label, and vector-only refuses", async () => {
    const embedding = new RecordingEmbedding();
    const { port } = await open(embedding);
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    const healthy = await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" });
    expect(healthy.degraded).not.toContain("vector-unavailable");
    expect(healthy.space).toBe(FIXTURE_SPACE.id);

    embedding.failQueries = true;
    const hybrid = await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" });
    expect(hybrid.hits.map((hit) => hit.doc_id)).toEqual(["page:grace"]);
    expect(hybrid.degraded).toContain("vector-unavailable");
    expect(hybrid.space).toBeNull();
    await expect(
      port.search({ ...SYNTHETIC_QUERY, mode: "vector" }),
    ).rejects.toBeInstanceOf(PortError);
  });

  test("an engine bound without an embedder labels hybrid as vector-skipped", async () => {
    const { port } = await open();
    await port.upsert([SYNTHETIC_DOCS[0]!]);
    expect(
      (await port.search({ ...SYNTHETIC_QUERY, mode: "hybrid" })).degraded,
    ).toContain("vector-skipped");
    expect(port.descriptor.supports).not.toContain("vector");
  });
});

describe("the embedding backlog", () => {
  test("an upsert embeds the documents it wrote and leaves an older backlog to the backfill pass", async () => {
    const embedding = new RecordingEmbedding();
    const { port } = await open(embedding, { chunk_tokens: 1, chunk_overlap: 0 });
    // The embedding server is down for the first write: the document is stored and searchable by text, unembedded.
    embedding.failAfter = 0;
    await expect(port.upsert([doc("page:old", words(30, "o"))])).rejects.toBeInstanceOf(PortError);
    embedding.failAfter = null;
    embedding.chunks.length = 0;

    await port.upsert([doc("page:new", words(5, "n"))]);
    expect(new Set(embedding.chunks.map((chunk) => chunk.doc_id))).toEqual(new Set(["page:new"]));
    const health = await port.health();
    expect(health.status === "ready" && health.detail["backlog_depth"]).toBe(30);

    const labelled = await port.search({ ...SYNTHETIC_QUERY, text: "o1", mode: "hybrid" });
    expect(labelled.degraded).toContain("vector-backlog");

    expect(await port.embedPending({ limit: 10 })).toEqual({ chunks: 10, documents: 1, remaining: 20 });
    expect(await port.embedPending()).toEqual({ chunks: 20, documents: 1, remaining: 0 });
    expect(await port.embedPending()).toEqual({ chunks: 0, documents: 0, remaining: 0 });
    const drained = await port.search({ ...SYNTHETIC_QUERY, text: "o1", mode: "hybrid" });
    expect(drained.degraded).not.toContain("vector-backlog");
  });

  test("chunks written before an embedder was bound are cut again for it", async () => {
    const lexical = await open();
    await lexical.port.upsert([doc("page:long", words(30))]);
    expect((await chunkRows(lexical.port)).map((row) => row.body)).toEqual([
      words(30),
    ]);
    await lexical.port.close();

    const embedding = new RecordingEmbedding();
    const reopened = await openEmbeddedRetrievalPort(lexical.temporary.ctx, {
      embedding,
      chunk_tokens: 8,
      chunk_overlap: 2,
    });
    cleanups.unshift(() => reopened.close());
    const progress = await reopened.embedPending();
    const rows = await chunkRows(reopened);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.body.split(" ").length <= 8)).toBe(true);
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
    expect(progress).toEqual({
      chunks: rows.length,
      documents: 1,
      remaining: 0,
    });
  });
});

describe("chunks cut for another tokenizer", () => {
  test("a chunk the embedder refuses is cut again once, and the chunks behind it are not stalled", async () => {
    // Two documents written by a lexical-only process, then an embedder that accepts at most 10 characters a chunk.
    const lexical = await open();
    await lexical.port.upsert([doc("page:a", "alpha bravo charlie delta echo foxtrot"), doc("page:b", "golf hotel")]);
    await lexical.port.close();
    const embedding = new RecordingEmbedding();
    const strict = embedding.embedDocs.bind(embedding);
    embedding.embedDocs = async (chunks) => {
      if (chunks.some((chunk) => chunk.text.length > 10)) throw new PortError("budget_exhausted", "too long", false);
      return strict(chunks);
    };
    const reopened = await openEmbeddedRetrievalPort(lexical.temporary.ctx, { embedding, chunk_tokens: 1, chunk_overlap: 0 });
    cleanups.unshift(() => reopened.close());
    // Pretend the stamp says these chunks already suit this embedder, as after a disable and re-enable of the port.
    await (reopened as unknown as { store: { setMeta(key: string, value: unknown): Promise<void> } }).store.setMeta("chunking", "fixture-whitespace:1:0");
    const progress = await reopened.embedPending();
    expect(progress.remaining).toBe(0);
    expect((await chunkRows(reopened)).every((row) => row.embedding !== null && row.body.length <= 10)).toBe(true);
  });

  test("a chunk that is refused even after it is cut again is the caller's error", async () => {
    const { port } = await open(new RecordingEmbedding(), { chunk_tokens: 2, chunk_overlap: 0 });
    const refusing = (port as unknown as { options: { embedding: RecordingEmbedding } }).options.embedding;
    refusing.embedDocs = async () => { throw new PortError("budget_exhausted", "too long", false); };
    await expect(port.upsert([doc("page:c", "one two three")])).rejects.toMatchObject({ code: "budget_exhausted" });
  });
});

describe("rebuild", () => {
  const corpus = [
    doc("page:a", words(20, "a")),
    doc("page:b", words(20, "b")),
    doc("page:c", "short note"),
  ];
  const options = { chunk_tokens: 8, chunk_overlap: 2 };

  test("re-embeds only the documents that changed", async () => {
    const embedding = new RecordingEmbedding();
    const { port } = await open(embedding, options);
    await port.rebuildFromDocuments(corpus);
    const first = embedding.chunks.length;
    expect(first).toBeGreaterThan(corpus.length);

    await port.rebuildFromDocuments(corpus);
    expect(embedding.chunks).toHaveLength(first);

    embedding.chunks.length = 0;
    await port.rebuildFromDocuments([
      corpus[0]!,
      { ...corpus[1]!, text: words(20, "changed") },
      corpus[2]!,
    ]);
    expect(new Set(embedding.chunks.map((chunk) => chunk.doc_id))).toEqual(
      new Set(["page:b"]),
    );
    const rows = await chunkRows(port);
    expect(
      rows
        .filter((row) => row.chunk_id.startsWith("page:b#"))
        .map((row) => row.body)
        .join(" "),
    ).toContain("changed0");
    expect(rows.every((row) => row.embedding !== null)).toBe(true);
  });

  test("a vector-layer rebuild embeds every chunk again", async () => {
    const embedding = new RecordingEmbedding();
    const { port } = await open(embedding, options);
    await port.rebuildFromDocuments(corpus);
    const first = embedding.chunks.length;
    await port.rebuildLayer("vector");
    expect(embedding.chunks).toHaveLength(first * 2);
  });

  test("an index grown by upserts and backfill equals one rebuilt from the same documents", async () => {
    const grown = await open(new RecordingEmbedding(), options);
    await grown.port.upsert(corpus);
    await grown.port.embedPending();
    const rebuilt = await open(new RecordingEmbedding(), options);
    await rebuilt.port.rebuildFromDocuments(corpus);

    expect(await chunkRows(grown.port)).toEqual(await chunkRows(rebuilt.port));
    const question = {
      ...SYNTHETIC_QUERY,
      text: "a3 a4 a5",
      mode: "hybrid" as const,
      scope: { kinds: ["page" as const] },
      limit: 5,
    };
    const [left, right] = [
      await grown.port.search(question),
      await rebuilt.port.search(question),
    ];
    expect(left.hits.map((hit) => [hit.doc_id, hit.score])).toEqual(
      right.hits.map((hit) => [hit.doc_id, hit.score]),
    );
    expect(left.space).toBe(right.space);
  });
});

describe("the engine's memory bound", () => {
  const MIB = 1024 * 1024;
  const readRefusal = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8")) as { refusal?: { corpus_bytes: number; limit_bytes: number } }).refusal;
  const big = (id: string, mib: number) => doc(id, `${id} `.repeat(Math.ceil((mib * MIB) / (id.length + 1))));

  test("a corpus over the bound is refused, the old index stays, and the reason is on disk", async () => {
    const { port: bounded, temporary } = await open(undefined, { max_text_bytes: 2 * MIB });
    await bounded.upsert([doc("page:small", "a small note about kettles")]);
    await expect(bounded.upsert([big("page:huge", 3)])).rejects.toMatchObject({ code: "budget_exhausted", retryable: false });
    expect((await bounded.search({ ...SYNTHETIC_QUERY, text: "kettles" })).hits.map((hit) => hit.doc_id)).toEqual(["page:small"]);
    const refusal = readRefusal(temporary.ctx.data_dir);
    expect(refusal?.limit_bytes).toBe(2 * MIB);
    expect(refusal?.corpus_bytes).toBeGreaterThan(3 * MIB);
    expect(readRetrievalEngineRefusal(temporary.ctx.vault_path, "kizuki.retrieval.embedded-pg")).toMatchObject({ limit_bytes: 2 * MIB });

    // Replacing the same document with a small one fits again and clears the record.
    await bounded.upsert([doc("page:small", "a small note about teapots")]);
    expect(readRefusal(temporary.ctx.data_dir)).toBeUndefined();
  });

  test("a rebuild stops reading at the bound and leaves the active index alone", async () => {
    const { port: bounded, temporary } = await open(undefined, { max_text_bytes: 2 * MIB });
    await bounded.rebuildFromDocuments([doc("page:kept", "a note about kettles")]);
    let read = 0;
    function* corpus() {
      for (let at = 0; at < 50; at += 1) {
        read += 1;
        yield big(`page:doc-${at}`, 1);
      }
    }
    await expect(bounded.rebuildFromDocuments(corpus())).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(read).toBeLessThan(5);
    expect((await bounded.search({ ...SYNTHETIC_QUERY, text: "kettles" })).hits.map((hit) => hit.doc_id)).toEqual(["page:kept"]);
    expect(readRefusal(temporary.ctx.data_dir)).toBeDefined();
    await bounded.rebuildFromDocuments([doc("page:kept", "a note about kettles")]);
    expect(readRefusal(temporary.ctx.data_dir)).toBeUndefined();
  });

  test("the bound comes from port configuration, within limits", async () => {
    const temporary = temporaryPortContext();
    cleanups.push(temporary.cleanup);
    for (const bad of [0, 1024, "big", 2 ** 40]) {
      await expect(openEmbeddedRetrievalPort({ ...temporary.ctx, config: { max_text_bytes: bad } })).rejects.toMatchObject({ code: "config_invalid" });
    }
    const port = await openEmbeddedRetrievalPort({ ...temporary.ctx, config: { max_text_bytes: 2 * MIB } });
    cleanups.unshift(() => port.close());
    await expect(port.upsert([big("page:huge", 3)])).rejects.toMatchObject({ code: "budget_exhausted" });
    const health = await port.health();
    expect(health.status === "ready" && health.detail["max_text_bytes"]).toBe(2 * MIB);
  });
});

describe("who closes the embedding port", () => {
  test("an engine closes an embedding port it owns and leaves a borrowed one usable", async () => {
    for (const owned of [true, false]) {
      const embedding = new RecordingEmbedding();
      const temporary = temporaryPortContext();
      cleanups.push(temporary.cleanup);
      const port = await openEmbeddedRetrievalPort(temporary.ctx, { embedding, own_embedding: owned });
      await port.close();
      const outcome = await embedding.embedQuery(["grace"]).then(() => "open", () => "closed");
      expect(outcome).toBe(owned ? "closed" : "open");
    }
  });
});
