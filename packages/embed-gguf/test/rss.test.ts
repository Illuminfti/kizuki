import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  test("pinned context and batch keep isolated RSS under the asserted ceiling", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "rss-once.ts")],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      rss: number;
      rss_ceiling_bytes: unknown;
      context_size: unknown;
      batch_size: unknown;
      contract_ceiling: number;
    };
    expect(report.contract_ceiling).toBe(RSS_CEILING_BYTES);
    expect(report.rss_ceiling_bytes).toBe(RSS_CEILING_BYTES);
    expect(report.context_size).toBe(64);
    expect(report.batch_size).toBe(8);
    expect(report.rss).toBeLessThan(RSS_CEILING_BYTES);
  });

  test("this file's embed work does not add a ceiling of RSS to the shared process", async () => {
    const before = process.memoryUsage().rss;
    const temporary = temporaryEmbed({
      context_size: 64,
      batch_size: 8,
    });
    cleanups.push(temporary.cleanup);
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
      const delta = process.memoryUsage().rss - before;
      expect(delta).toBeLessThan(RSS_CEILING_BYTES);
      const health = await port.health();
      if (health.status !== "ready") throw new Error("expected ready");
      expect(health.detail["rss_ceiling_bytes"]).toBe(RSS_CEILING_BYTES);
    } finally {
      await port.close();
    }
  });
});
