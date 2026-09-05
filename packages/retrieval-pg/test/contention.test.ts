import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import type { RetrievalDoc } from "@kizuki/core";
import {
  DEFAULT_HEARTBEAT_MS,
  EmbeddedRetrievalPort,
  McpEngineSurface,
  STALE_HEARTBEAT_MULTIPLIER,
  WriterLease,
  createEmbeddedRetrievalPort,
  openEmbeddedRetrievalPort,
  writeSyntheticHolder,
} from "../src/index";
import {
  FIXED_NOW,
  FixtureEmbeddingPort,
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  sleep,
  temporaryPortContext,
} from "./helpers";

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function open(
  options: {
    embedding?: FixtureEmbeddingPort;
    chunk_tokens?: number;
    chunk_overlap?: number;
    holder_id?: string;
  } = {},
): Promise<{ port: EmbeddedRetrievalPort; dataDir: string; cleanup: () => Promise<void> }> {
  const temporary = temporaryPortContext();
  const port = await createEmbeddedRetrievalPort(temporary.ctx, options);
  const cleanup = async () => {
    await port.close();
    temporary.cleanup();
  };
  disposers.push(cleanup);
  return { port, dataDir: temporary.ctx.data_dir, cleanup };
}

const LONG_DOC: RetrievalDoc = {
  doc_id: "page:long",
  kind: "page",
  title: "Long page",
  text: "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
  sensitivity: "personal",
  taint: "clean",
  authority: "connector_evidence",
  subjects: ["person:grace"],
  provenance: ["event:long"],
  occurred_at: "2026-08-20T09:00:00.000Z",
  updated_at: FIXED_NOW,
};

describe("embedded retrieval contention", () => {
  test("single writer lease is exclusive", async () => {
    const { dataDir } = await open({ holder_id: "writer-a" });
    const temporary = {
      vault_path: join(dataDir, "..", "..", ".."),
      data_dir: dataDir,
      config: {},
      secrets: async () => "synthetic-contract-token",
      clock: () => FIXED_NOW,
      logger: () => {},
    };
    await expect(createEmbeddedRetrievalPort(temporary, { holder_id: "writer-b" })).rejects.toBeInstanceOf(PortError);
    try {
      await createEmbeddedRetrievalPort(temporary, { holder_id: "writer-b" });
      throw new Error("expected exclusive lease");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("lease_required");
    }
  });

  test("a live holder's lease is never stolen", async () => {
    const temporary = temporaryPortContext();
    disposers.push(temporary.cleanup);
    writeSyntheticHolder(temporary.ctx.data_dir, {
      pid: process.pid,
      holder_id: "live-holder",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      acquired_at: "2020-01-01T00:00:00.000Z",
    });
    await expect(createEmbeddedRetrievalPort(temporary.ctx)).rejects.toBeInstanceOf(PortError);
    try {
      await createEmbeddedRetrievalPort(temporary.ctx);
      throw new Error("expected live lease to stay");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("lease_required");
      expect((error as PortError).message).toContain("live");
    }
    const lease = new WriterLease(temporary.ctx.data_dir, {
      clock: () => FIXED_NOW,
    });
    const snapshot = lease.inspect();
    expect(snapshot.live).toBe(true);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.holder?.holder_id).toBe("live-holder");
  });

  test("a dead holder's lease is reclaimed with a receipt", async () => {
    const temporary = temporaryPortContext();
    disposers.push(temporary.cleanup);
    const deadPid = 2_147_000_000;
    expect(WriterLease.prototype).toBeDefined();
    writeSyntheticHolder(temporary.ctx.data_dir, {
      pid: deadPid,
      holder_id: "dead-holder",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      acquired_at: "2020-01-01T00:00:00.000Z",
    });
    const port = await createEmbeddedRetrievalPort(temporary.ctx, {
      holder_id: "replacement",
    });
    disposers.push(async () => {
      await port.close();
    });
    expect(port.leaseReceipt.action).toBe("reclaimed");
    expect(port.leaseReceipt.previous?.holder_id).toBe("dead-holder");
    const receipts = new WriterLease(temporary.ctx.data_dir).readReceipts();
    expect(receipts.some((item) => item.action === "reclaimed")).toBe(true);
    expect(
      STALE_HEARTBEAT_MULTIPLIER * DEFAULT_HEARTBEAT_MS,
    ).toBeGreaterThan(0);
  });

  test("starvation reports as timeout with queue depth", async () => {
    const { port, dataDir } = await open({ holder_id: "holder" });
    const waiting = openEmbeddedRetrievalPort(
      {
        vault_path: join(dataDir, "..", "..", ".."),
        data_dir: dataDir,
        config: {},
        secrets: async () => "synthetic-contract-token",
        clock: () => FIXED_NOW,
        logger: () => {},
      },
      { acquire_timeout_ms: 80, holder_id: "waiter" },
    );
    await sleep(20);
    const health = await port.health();
    if (health.status === "ready" || health.status === "degraded") {
      expect(Number(health.detail["queue_depth"])).toBeGreaterThan(0);
    } else {
      throw new Error("holder health should remain ready");
    }
    try {
      await waiting;
      throw new Error("expected waiter timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("timeout");
      expect((error as PortError).retryable).toBe(true);
      expect((error as PortError).message).toContain("queue_depth=");
    }
  });

  test("no txn spans an embed call", async () => {
    const embedder = new FixtureEmbeddingPort();
    const { port } = await open({ embedding: embedder });
    try {
      await port.embedInsideOpenTransaction();
      throw new Error("expected txn guard");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).message).toContain("no txn spans an embed call");
    }

    const srcRoot = join(import.meta.dir, "../src");
    const sources = walkTs(srcRoot);
    expect(sources.length).toBeGreaterThan(0);
    let guarded = 0;
    for (const path of sources) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /runStoreTransaction\([^)]*(?:embedDocs|embedQuery|embedPending)/,
      );
      if (
        source.includes("assertNoStoreTransaction(\"embedDocs\")") ||
        source.includes("assertNoStoreTransaction(\"embedQuery\")") ||
        source.includes("assertNoStoreTransaction(\"embedPending\")")
      ) {
        guarded += 1;
      }
    }
    expect(guarded).toBeGreaterThan(0);
  });

  test("bulk edit produces one refresh pass", async () => {
    const { port, dataDir } = await open();
    const root = join(dataDir, "watch");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = port.watch({
      root,
      refresh: async () => {
        await blocked;
      },
    });
    for (let index = 0; index < 20; index += 1) {
      const path = join(root, `page-${index}.md`);
      writeFileSync(path, `page ${index}\n`, { mode: 0o600 });
      void watcher.handle({ type: "change", path });
    }
    await sleep(20);
    expect(watcher.refreshPasses).toBe(1);
    release?.();
    await watcher.idle();
    expect(watcher.refreshPasses).toBeLessThanOrEqual(2);
    expect(watcher.refreshPasses).toBeGreaterThanOrEqual(1);
  });

  test("self-write is not re-ingested", async () => {
    const { port, dataDir } = await open();
    const root = join(dataDir, "watch");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const watcher = port.watch({ root });
    const path = join(root, "self.md");
    port.recordSelfWrite(path, "owner wrote this page\n");
    await watcher.handle({ type: "change", path });
    await watcher.idle();
    expect(watcher.ignoredSelfWrites).toBe(1);
    expect(watcher.refreshPasses).toBe(0);
  });

  test("rename-into-place is detected", async () => {
    const { port, dataDir } = await open();
    const root = join(dataDir, "watch");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const watcher = port.watch({ root });
    const tmp = join(root, "page.md.tmp");
    const path = join(root, "page.md");
    writeFileSync(tmp, "renamed into place\n", { mode: 0o600 });
    renameSync(tmp, path);
    await watcher.handle({ type: "rename", path });
    await watcher.idle();
    expect(watcher.detectedRenames).toContain(path);
    expect(watcher.refreshPasses).toBe(1);
  });

  test("phantom embeddings are detected and repaired", async () => {
    const embedder = new FixtureEmbeddingPort();
    const { port } = await open({ embedding: embedder });
    await port.upsert(SYNTHETIC_DOCS);
    const healthy = await port.health();
    expect(healthy.status).toBe("ready");
    await port.injectPhantom("page:grace");
    const sick = await port.health();
    expect(sick.status).toBe("unavailable");
    if (sick.status === "unavailable") {
      expect(sick.reason).toContain("phantom embeddings");
    }
    await port.rebuildLayer("vector");
    const repaired = await port.health();
    expect(repaired.status).toBe("ready");
    if (repaired.status === "ready") {
      expect(repaired.detail["phantoms"]).toBe(0);
    }
  });

  test("mcp surface opens the engine once", async () => {
    const temporary = temporaryPortContext();
    disposers.push(temporary.cleanup);
    const surface = new McpEngineSurface();
    disposers.push(async () => {
      await surface.close();
    });
    const first = await surface.invoke(temporary.ctx, {}, async (port) => {
      await port.upsert(SYNTHETIC_DOCS);
      return port.search(SYNTHETIC_QUERY);
    });
    const second = await surface.invoke(temporary.ctx, {}, async (port) =>
      port.search(SYNTHETIC_QUERY),
    );
    expect(surface.engineOpens).toBe(1);
    expect(first.hits.length).toBeGreaterThan(0);
    expect(second.hits.map(({ doc_id }) => doc_id)).toEqual(
      first.hits.map(({ doc_id }) => doc_id),
    );
  });

  test("embedding resumes after kill at the same chunk", async () => {
    const temporary = temporaryPortContext();
    disposers.push(temporary.cleanup);
    const embedder = new FixtureEmbeddingPort();
    embedder.failAfter = 1;
    const first = await createEmbeddedRetrievalPort(temporary.ctx, {
      embedding: embedder,
      chunk_tokens: 3,
      chunk_overlap: 0,
      holder_id: "embed-1",
    });
    try {
      await first.upsert([LONG_DOC]);
      throw new Error("expected embedder kill");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
    }
    const checkpoint = first.embedCheckpoint();
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.doc_id).toBe("page:long");
    expect(checkpoint?.chunk_index).toBe(1);
    await first.close();

    const resumeEmbedder = new FixtureEmbeddingPort();
    const second = await createEmbeddedRetrievalPort(temporary.ctx, {
      embedding: resumeEmbedder,
      chunk_tokens: 3,
      chunk_overlap: 0,
      holder_id: "embed-2",
    });
    disposers.push(async () => {
      await second.close();
    });
    expect(second.embedCheckpoint()?.chunk_index).toBe(1);
    expect(second.embedCheckpoint()?.doc_id).toBe("page:long");
    await second.embedPending();
    const health = await second.health();
    expect(health.status).toBe("ready");
    if (health.status === "ready") {
      expect(Number(health.detail["backlog_depth"])).toBe(0);
    }
    expect(resumeEmbedder.calls).toBeGreaterThan(0);
  });
});

function walkTs(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}
