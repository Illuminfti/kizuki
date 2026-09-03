import { afterEach, describe, expect, test } from "bun:test";
import {
  RSS_CEILING_BYTES,
  createGgufEmbeddingPort,
} from "../src/index";
import { temporaryEmbed } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("GGUF embedding RSS ceiling", () => {
  test("pinned context and batch keep RSS under the asserted ceiling", async () => {
    const temporary = temporaryEmbed({
      context_size: 64,
      batch_size: 8,
    });
    cleanups.push(temporary.cleanup);
    // The ceiling bounds what the port adds to a process, not the process
    // itself: the test runner already holds the rest of the suite in memory.
    const baseline = process.memoryUsage().rss;
    const port = createGgufEmbeddingPort(temporary.ctx);
    try {
      const texts = Array.from(
        { length: 8 },
        (_, index) => `grace partnerships ${index}`,
      );
      for (let round = 0; round < 8; round += 1) {
        const vectors = await port.embedQuery(texts);
        expect(vectors).toHaveLength(8);
        expect(vectors[0]?.length).toBe(8);
      }
      const growth = process.memoryUsage().rss - baseline;
      expect(growth).toBeLessThan(RSS_CEILING_BYTES);
      const health = await port.health();
      if (health.status !== "ready") throw new Error("expected ready");
      expect(health.detail["rss_ceiling_bytes"]).toBe(RSS_CEILING_BYTES);
      expect(health.detail["context_size"]).toBe(64);
      expect(health.detail["batch_size"]).toBe(8);
    } finally {
      await port.close();
    }
  });
});
