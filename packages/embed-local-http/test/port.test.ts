import { afterEach, describe, expect, test } from "bun:test";
import { PortError, PortRegistry, runEmbeddingConformance } from "@kizuki/core";
import type { EmbeddingPort } from "@kizuki/core";
import {
  LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
  LOCAL_HTTP_EMBEDDING_ID,
  createLocalHttpEmbeddingPort,
  estimateTokens,
  registerLocalHttpEmbedding,
} from "../src/index";
import {
  DIMS,
  configFor,
  fixtureChunks,
  hashVector,
  startFakeServer,
  temporaryEmbed,
} from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(overrides: Record<string, unknown> = {}) {
  const server = startFakeServer();
  const temporary = temporaryEmbed(configFor(server.port, overrides));
  cleanups.push(() => server.stop(), temporary.cleanup);
  return {
    server,
    temporary,
    open: () => createLocalHttpEmbeddingPort(temporary.ctx),
  };
}

async function refusal(work: () => unknown): Promise<PortError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(PortError);
    return error as PortError;
  }
  throw new Error("expected a PortError");
}

function bind(port: number, endpoint: string) {
  const temporary = temporaryEmbed(configFor(port, { endpoint }));
  cleanups.push(temporary.cleanup);
  return () => createLocalHttpEmbeddingPort(temporary.ctx);
}

describe("kizuki.embedding.local-http configuration", () => {
  test.each([
    "http://localhost:8080",
    "http://example.com:8080",
    "http://10.0.0.5:8080",
    "http://192.168.1.10:8080",
    "http://0.0.0.0:8080",
    "http://[::ffff:127.0.0.1]:8080",
    "http://[2001:db8::1]:8080",
    "https://127.0.0.1:8080",
    "ftp://127.0.0.1:8080",
    "http://user:secret@127.0.0.1:8080",
    "http://127.0.0.1:8080/v1/embeddings",
    "http://127.0.0.1:8080/?token=1",
    "http://127.0.0.1:8080/#frag",
    "127.0.0.1:8080",
    "",
  ])("refuses the endpoint %p before any request", async (endpoint) => {
    const open = bind(1, endpoint);
    expect(open).toThrow(PortError);
    expect((await refusal(async () => open())).code).toBe("config_invalid");
  });

  test.each([
    "http://127.0.0.1:8080",
    "http://127.5.6.7:9",
    "http://[::1]:8080",
    "http://2130706433:9",
    "http://0x7f.1:9",
  ])("accepts the loopback endpoint %p", (endpoint) => {
    const open = bind(1, endpoint);
    expect(open().space().dims).toBe(DIMS);
  });

  test.each(["api", "endpoint", "model", "dims", "max_input_tokens"] as const)(
    "requires %s to be pinned",
    async (field) => {
      const config = { ...configFor(1) };
      delete config[field];
      const temporary = temporaryEmbed(config);
      cleanups.push(temporary.cleanup);
      expect(
        (await refusal(async () => createLocalHttpEmbeddingPort(temporary.ctx)))
          .code,
      ).toBe("config_invalid");
    },
  );

  test("refuses auto sizing, an unknown wire format and prompts without their slot", async () => {
    for (const overrides of [
      { dims: "auto" },
      { max_input_tokens: "auto" },
      { api: "grpc" },
      { dims: 0 },
      { dims: 2_001 },
      { prompt_query: "search_query: (no slot)" },
      { prompt_doc: "search_document: (no slot)" },
      { chunk_tokens: 100_000 },
      { chunk_overlap: 500, chunk_tokens: 400 },
      { max_input_tokens: 64 },
    ]) {
      const temporary = temporaryEmbed(configFor(1, overrides));
      cleanups.push(temporary.cleanup);
      expect(
        (await refusal(async () => createLocalHttpEmbeddingPort(temporary.ctx)))
          .code,
      ).toBe("config_invalid");
    }
  });

  test("a chunk, its prompt, a capped title and the special tokens always fit the window", () => {
    const { open } = fixture({
      prompt_doc: "search_document: {title}\n{text}",
    });
    const space = open().space();
    expect(space.chunk.tokens).toBeLessThanOrEqual(
      512 - 64 - 8 - estimateTokens("search_document:"),
    );
  });
});

describe("kizuki.embedding.local-http wire formats", () => {
  test("posts an OpenAI-compatible request and frames the query", async () => {
    const { server, open } = fixture({ prompt_query: "search_query: {q}" });
    const port = open();
    const [vector] = await port.embedQuery(["grace partnerships"]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.path).toBe("/v1/embeddings");
    expect(server.requests[0]!.body).toEqual({
      model: "Synthetic-Embed:v1",
      input: ["search_query: grace partnerships"],
      encoding_format: "float",
    });
    expect([...vector!]).toEqual(
      hashVector("search_query: grace partnerships"),
    );
    expect(vector).toBeInstanceOf(Float32Array);
  });

  test("posts an ollama-compatible request that refuses to truncate", async () => {
    const { server, open } = fixture({ api: "ollama" });
    const [vector] = await open().embedQuery(["grace"]);
    expect(server.requests[0]!.path).toBe("/api/embed");
    expect(server.requests[0]!.body).toEqual({
      model: "Synthetic-Embed:v1",
      input: ["grace"],
      truncate: false,
    });
    expect(vector).toHaveLength(DIMS);
  });

  test("frames each document with its own title and never expands slots inside the text", async () => {
    const { server, open } = fixture({
      prompt_doc: "search_document: {title} | {text}",
    });
    await open().embedDocs([
      {
        chunk_id: "c0",
        doc_id: "page:a",
        title: "Grace at Acme",
        text: "costs $& and {title} literally",
        index: 0,
      },
    ]);
    expect(server.requests[0]!.body.input).toEqual([
      "search_document: Grace at Acme | costs $& and {title} literally",
    ]);
  });

  test("never embeds the document id in place of the title", async () => {
    const { server, open } = fixture({ prompt_doc: "{title}: {text}" });
    await open().embedDocs(fixtureChunks());
    for (const input of server.requests.flatMap(
      (request) => request.body.input,
    )) {
      expect(input).toStartWith("Grace at Acme: ");
      expect(input).not.toContain("page:grace");
    }
  });

  test("splits a large call into batches and keeps the order", async () => {
    const { server, open } = fixture({ batch_size: 2 });
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      chunk_id: `c${index}`,
      doc_id: "page:a",
      title: "T",
      text: `word${index}`,
      index,
    }));
    const vectors = await open().embedDocs(chunks);
    expect(server.requests.map((request) => request.body.input.length)).toEqual(
      [2, 2, 1],
    );
    expect(vectors.map((vector) => [...vector])).toEqual(
      chunks.map((chunk) => hashVector(`T\n\n${chunk.text}`)),
    );
  });

  test("puts out-of-order OpenAI rows back in input order", async () => {
    const { server, open } = fixture();
    server.behaviour = { kind: "shuffle" };
    const inputs = ["alpha", "bravo", "charlie"];
    const vectors = await open().embedQuery(inputs);
    expect(vectors.map((vector) => [...vector])).toEqual(
      inputs.map((text) => hashVector(text)),
    );
  });

  test("reads a chunked reply", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        const text = JSON.stringify({
          data: body.input.map((input, index) => ({
            index,
            embedding: hashVector(input),
          })),
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(text);
              controller.enqueue(bytes.slice(0, 20));
              controller.enqueue(bytes.slice(20));
              controller.close();
            },
          }),
        );
      },
    });
    cleanups.push(() => server.stop(true));
    const temporary = temporaryEmbed(configFor(server.port ?? 0));
    cleanups.push(temporary.cleanup);
    const [vector] = await createLocalHttpEmbeddingPort(
      temporary.ctx,
    ).embedQuery(["grace"]);
    expect([...vector!]).toEqual(hashVector("grace"));
  });
});

describe("kizuki.embedding.local-http failure handling", () => {
  test("a wrong width, a short reply and a non-finite value are a space mismatch, never padded", async () => {
    const { server, open } = fixture();
    const port = open();
    for (const behaviour of [
      { kind: "width", dims: 5 },
      { kind: "short" },
      { kind: "null-value" },
    ] as const) {
      server.behaviour = behaviour;
      const error = await refusal(() => port.embedQuery(["one", "two"]));
      expect(error.code).toBe("space_mismatch");
      expect(error.retryable).toBe(false);
    }
  });

  test("a slow server is a retryable timeout", async () => {
    const { server, open } = fixture({ timeout_ms: 150 });
    server.behaviour = { kind: "delay", ms: 1_000 };
    const error = await refusal(() => open().embedQuery(["grace"]));
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  test("a stopped server is retryable and health reports it until a request succeeds", async () => {
    const { server, open } = fixture();
    const port = open();
    server.stop();
    const error = await refusal(() => port.embedQuery(["grace"]));
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
    const degraded = await port.health();
    expect(degraded.status).toBe("degraded");
    if (degraded.status === "degraded")
      expect(degraded.degraded).toEqual(["embedding-unreachable"]);

    const revived = startFakeServer();
    cleanups.push(() => revived.stop());
    const again = createLocalHttpEmbeddingPort(
      temporaryEmbed(configFor(revived.port)).ctx,
    );
    await again.embedQuery(["grace"]);
    expect((await again.health()).status).toBe("ready");
  });

  test("server errors say whether a retry can help and never echo the input", async () => {
    const { server, open } = fixture();
    const port = open();
    server.behaviour = { kind: "status", status: 503 };
    const busy = await refusal(() => port.embedQuery(["private words"]));
    expect(busy.retryable).toBe(true);
    server.behaviour = { kind: "status", status: 400 };
    const bad = await refusal(() => port.embedQuery(["private words"]));
    expect(bad.retryable).toBe(false);
    server.behaviour = { kind: "garbage" };
    const garbage = await refusal(() => port.embedQuery(["private words"]));
    expect(garbage.retryable).toBe(false);
    for (const error of [busy, bad, garbage])
      expect(error.message).not.toContain("private");
  });

  test("a redirect is refused and not followed", async () => {
    const { server, open } = fixture();
    server.behaviour = { kind: "redirect" };
    const error = await refusal(() => open().embedQuery(["grace"]));
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  test("a reply over the byte cap is refused", async () => {
    const { server, open } = fixture();
    server.behaviour = { kind: "huge" };
    expect((await refusal(() => open().embedQuery(["grace"]))).code).toBe(
      "unavailable",
    );
  });

  test("an input over the model window is refused before any request", async () => {
    const { server, open } = fixture({ max_input_tokens: 128 });
    const error = await refusal(() =>
      open().embedQuery([Array.from({ length: 400 }, () => "word").join(" ")]),
    );
    expect(error.code).toBe("budget_exhausted");
    expect(server.requests).toHaveLength(0);
  });

  test("a closed port refuses work", async () => {
    const { open } = fixture();
    const port = open();
    await port.close();
    expect((await refusal(() => port.embedQuery(["grace"]))).code).toBe(
      "unavailable",
    );
    expect(() => port.space()).toThrow(PortError);
  });

  test("HTTP_PROXY in the environment cannot reroute the request", async () => {
    const seen: string[] = [];
    const canary = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.url);
        return new Response("{}");
      },
    });
    cleanups.push(() => canary.stop(true));
    const before = {
      upper: process.env["HTTP_PROXY"],
      lower: process.env["http_proxy"],
    };
    process.env["HTTP_PROXY"] = `http://127.0.0.1:${canary.port}`;
    process.env["http_proxy"] = `http://127.0.0.1:${canary.port}`;
    try {
      const { server, open } = fixture();
      await open().embedQuery(["private words"]);
      expect(server.requests).toHaveLength(1);
      expect(seen).toEqual([]);
    } finally {
      if (before.upper === undefined) delete process.env["HTTP_PROXY"];
      else process.env["HTTP_PROXY"] = before.upper;
      if (before.lower === undefined) delete process.env["http_proxy"];
      else process.env["http_proxy"] = before.lower;
    }
  });
});

describe("kizuki.embedding.local-http space identity", () => {
  const idOf = (overrides: Record<string, unknown>) => {
    const temporary = temporaryEmbed(configFor(1, overrides));
    cleanups.push(temporary.cleanup);
    return createLocalHttpEmbeddingPort(temporary.ctx).space();
  };

  test("names provider, model and width, and pins the prompts and the tokenizer", () => {
    const space = idOf({
      prompt_query: "search_query: {q}",
      prompt_doc: "search_document: {title}\n{text}",
    });
    expect(space.provider).toBe("local-http");
    expect(space.model).toBe("synthetic-embed-v1");
    expect(space.id).toMatch(/^local-http:synthetic-embed-v1@8#[0-9a-f]{8}$/);
    expect(space.tokenizer_id).toBe("kizuki:estimate-v1");
    expect(space.prompt_query).toBe("search_query: {q}");
    expect(space.prompt_doc).toBe("search_document: {title}\n{text}");
  });

  test("a prompt, model or width change is a new space; the endpoint and wire format are not", () => {
    const base = idOf({}).id;
    expect(idOf({ prompt_query: "query: {q}" }).id).not.toBe(base);
    expect(idOf({ prompt_doc: "doc: {title} {text}" }).id).not.toBe(base);
    expect(idOf({ dims: 16 }).id).not.toBe(base);
    expect(idOf({ model: "other" }).id).not.toBe(base);
    expect(idOf({ api: "ollama" }).id).toBe(base);
    expect(idOf({ endpoint: "http://127.0.0.1:65000" }).id).toBe(base);
    expect(idOf({ timeout_ms: 5_000 }).id).toBe(base);
  });

  test("refuses to start when the configured space is not the expected one", async () => {
    const expected = idOf({}).id;
    const temporary = temporaryEmbed(
      configFor(1, { prompt_query: "query: {q}", expected_space: expected }),
    );
    cleanups.push(temporary.cleanup);
    expect(
      (await refusal(async () => createLocalHttpEmbeddingPort(temporary.ctx)))
        .code,
    ).toBe("space_mismatch");
  });

  test("countTokens is additive over whitespace, so an engine can size chunks word by word", () => {
    const port = fixture().open();
    const samples = [
      "Grace runs partnerships at Acme.",
      "grace@acme.test 2026-09-02 12:00:00Z (v1.0.2)",
      "日本語のテキスト and mixed ASCII café naïve",
      "supercalifragilisticexpialidocious 1234567890",
    ];
    for (const text of samples) {
      const words = text.split(/\s+/).filter(Boolean);
      expect(
        words.reduce((sum, word) => sum + port.countTokens!(word), 0),
      ).toBe(port.countTokens!(text));
    }
    expect(port.countTokens!("")).toBe(0);
  });
});

describe("kizuki.embedding.local-http contract", () => {
  test("registers and binds through the port registry", async () => {
    const { temporary } = fixture();
    const registry = new PortRegistry();
    registerLocalHttpEmbedding(registry);
    const bound = await registry.bindFromConfig<EmbeddingPort>(
      "embedding",
      { embedding: LOCAL_HTTP_EMBEDDING_ID },
      temporary.ctx,
    );
    expect(bound.d).toEqual(LOCAL_HTTP_EMBEDDING_DESCRIPTOR);
    expect(bound.port.space().dims).toBe(DIMS);
  });

  test("passes shared embedding conformance against a fake loopback server", async () => {
    const server = startFakeServer();
    cleanups.push(() => server.stop());
    const report = await runEmbeddingConformance({
      descriptor: LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
      fixtures: { name: "embed-local-http" },
      create: async (ctx) =>
        createLocalHttpEmbeddingPort({
          ...ctx,
          config: configFor(server.port),
        }),
      destroy: async (port) => port.close(),
      driver: {
        apply: async (port) => port.embedDocs(fixtureChunks()),
        observe: async (port) => ({
          space: port.space(),
          query: await port.embedQuery(["grace"]),
        }),
        induceFailure: async (port) =>
          port.embedQuery([
            Array.from({ length: 1_000 }, (_, index) => `token${index}`).join(
              " ",
            ),
          ]),
        remove: async () => undefined,
        verifyAbsent: async () => ({ found: [] }),
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
