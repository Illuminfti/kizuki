import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PortError,
  PortRegistry,
  bindFromConfig,
  runEmbeddingConformance,
} from "@kizuki/core";
import type { EmbeddingPort } from "@kizuki/core";
import {
  GGUF_EMBEDDING_DESCRIPTOR,
  GGUF_EMBEDDING_ID,
  createGgufEmbeddingPort,
  fixtureSpaceId,
  registerGgufEmbedding,
  writeEmbeddingTableGguf,
  writeFixtureGguf,
} from "../src/index";
import { buildFixtureTable } from "../src/fixture";
import { fixtureChunks, temporaryEmbed } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("kizuki.embedding.gguf", () => {
  test("embeds query and document texts from a fixture GGUF path", async () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const port = createGgufEmbeddingPort(temporary.ctx);
    try {
      const space = port.space();
      expect(space.id).toBe(fixtureSpaceId());
      expect(space.provider).toBe("gguf");
      expect(space.model).toBe("kizuki-fixture-embed");
      expect(space.dims).toBe(8);
      expect(space.prompt_query).toBe("task: search result | query: {q}");
      expect(space.prompt_doc).toBe("title: {title} | text: {text}");
      expect(space.chunk).toEqual({ tokens: 800, overlap: 120 });

      const [query] = await port.embedQuery(["grace partnerships"]);
      const docs = await port.embedDocs(fixtureChunks());
      expect(query).toBeInstanceOf(Float32Array);
      expect(query?.length).toBe(8);
      expect(docs).toHaveLength(2);
      expect(docs[0]?.length).toBe(8);
      expect(docs[1]?.length).toBe(8);
      expect([...query ?? []]).not.toEqual([...(docs[0] ?? [])]);

      const again = await port.embedQuery(["grace partnerships"]);
      expect([...(again[0] ?? [])]).toEqual([...(query ?? [])]);

      const health = await port.health();
      expect(health).toEqual({
        status: "ready",
        detail: {
          space: fixtureSpaceId(),
          dims: 8,
          context_size: 32,
          batch_size: 4,
          rss_ceiling_bytes: 512 * 1024 * 1024,
        },
      });
    } finally {
      await port.close();
    }
  });

  test("missing model_path and missing GGUF file fail closed", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    expect(() =>
      createGgufEmbeddingPort({
        ...temporary.ctx,
        config: { context_size: 32, batch_size: 4 },
      }),
    ).toThrow(PortError);
    try {
      createGgufEmbeddingPort({
        ...temporary.ctx,
        config: { context_size: 32, batch_size: 4 },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("config_invalid");
    }

    expect(() =>
      createGgufEmbeddingPort({
        ...temporary.ctx,
        config: {
          model_path: join(temporary.root, "missing.gguf"),
          context_size: 32,
          batch_size: 4,
        },
      }),
    ).toThrow(PortError);
    try {
      createGgufEmbeddingPort({
        ...temporary.ctx,
        config: {
          model_path: join(temporary.root, "missing.gguf"),
          context_size: 32,
          batch_size: 4,
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("unavailable");
      expect((error as PortError).retryable).toBe(false);
    }
  });

  test("unpinned context or batch sizes are refused", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    for (const config of [
      { model_path: temporary.modelPath, batch_size: 4 },
      { model_path: temporary.modelPath, context_size: 32 },
      {
        model_path: temporary.modelPath,
        context_size: "auto",
        batch_size: 4,
      },
    ]) {
      try {
        createGgufEmbeddingPort({ ...temporary.ctx, config });
        throw new Error("expected pin refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("config_invalid");
      }
    }
  });

  test("expected space mismatch fails closed and never pads vectors", () => {
    const eight = temporaryEmbed({
      expected_space: "gguf:other-model@768",
    });
    cleanups.push(eight.cleanup);
    try {
      createGgufEmbeddingPort(eight.ctx);
      throw new Error("expected space mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("space_mismatch");
      expect((error as PortError).message).toContain("gguf:other-model@768");
    }

    const wide = temporaryEmbed({}, GGUF_EMBEDDING_DESCRIPTOR, {
      name: "wide-fixture",
      dims: 16,
    });
    cleanups.push(wide.cleanup);
    const port = createGgufEmbeddingPort(wide.ctx);
    try {
      expect(port.space().id).toBe("gguf:wide-fixture@16");
      expect(port.space().dims).toBe(16);
    } finally {
      void port.close();
    }
  });

  test("transformer GGUF architecture is refused", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const path = join(temporary.root, "models", "gemma.gguf");
    writeFileSync(
      path,
      writeEmbeddingTableGguf({
        ...buildFixtureTable(),
        architecture: "gemma3",
      }),
    );
    try {
      createGgufEmbeddingPort({
        ...temporary.ctx,
        config: {
          ...temporary.ctx.config,
          model_path: path,
        },
      });
      throw new Error("expected transformer refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("not_supported");
    }
  });

  test("over-budget batch or context throws PortError, not an empty list", async () => {
    const temporary = temporaryEmbed({
      context_size: 4,
      batch_size: 1,
    });
    cleanups.push(temporary.cleanup);
    const port = createGgufEmbeddingPort(temporary.ctx);
    try {
      await expect(port.embedQuery(["one", "two"])).rejects.toBeInstanceOf(
        PortError,
      );
      try {
        await port.embedQuery(["one", "two"]);
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("budget_exhausted");
      }

      const long = "grace acme partnerships contact email library kernel";
      try {
        await port.embedQuery([long]);
        throw new Error("expected context refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("budget_exhausted");
      }
    } finally {
      await port.close();
    }
  });

  test("concurrent embeds are single-flight and still return vectors", async () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const port = createGgufEmbeddingPort(temporary.ctx);
    try {
      const started: number[] = [];
      const finished: number[] = [];
      const first = port.embedQuery(["grace"]).then((value) => {
        started.push(1);
        finished.push(1);
        return value;
      });
      const second = port.embedQuery(["acme"]).then((value) => {
        started.push(2);
        finished.push(2);
        return value;
      });
      const [left, right] = await Promise.all([first, second]);
      expect(left[0]?.length).toBe(8);
      expect(right[0]?.length).toBe(8);
      expect(finished).toEqual([1, 2]);
    } finally {
      await port.close();
    }
  });

  test("registers and binds through the port registry", () => {
    const temporary = temporaryEmbed();
    cleanups.push(temporary.cleanup);
    const registry = new PortRegistry();
    registerGgufEmbedding(registry);
    const bound = registry.bindFromConfig<EmbeddingPort>(
      "embedding",
      { embedding: GGUF_EMBEDDING_ID },
      temporary.ctx,
    );
    expect(bound.d).toEqual(GGUF_EMBEDDING_DESCRIPTOR);
    expect(bound.port.space().id).toBe(fixtureSpaceId());
    expect(bindFromConfig).toBeTypeOf("function");
  });

  test("passes shared embedding conformance", async () => {
    const report = await runEmbeddingConformance({
      descriptor: GGUF_EMBEDDING_DESCRIPTOR,
      fixtures: { name: "embed-gguf" },
      create: async (ctx) => {
        const modelPath = join(ctx.data_dir, "fixture.gguf");
        writeFileSync(modelPath, writeFixtureGguf());
        return createGgufEmbeddingPort({
          ...ctx,
          config: {
            model_path: modelPath,
            context_size: 32,
            batch_size: 4,
          },
        });
      },
      destroy: async (port) => port.close(),
      driver: {
        apply: async (port) => port.embedDocs(fixtureChunks()),
        observe: async (port) => ({
          space: port.space(),
          query: await port.embedQuery(["grace"]),
        }),
        induceFailure: async (port) =>
          port.embedQuery([
            Array.from({ length: 40 }, (_, index) => `token${index}`).join(
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

  test("fixture writer produces a parseable GGUF", () => {
    const bytes = writeFixtureGguf();
    expect(bytes.byteLength).toBeGreaterThan(64);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("GGUF");
  });
});
