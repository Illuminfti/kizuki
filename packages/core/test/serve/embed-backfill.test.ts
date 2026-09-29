import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { PortError } from "../../src/contracts/ports";
import type { EmbedProgress, RetrievalPort } from "../../src/contracts/retrieval";
import { initVault } from "../../src/vault/init";
import { EMBED_PASS_CHUNKS, runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { emptyRunTotals } from "../../src/serve/types";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function vault(embedding: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-embed-backfill-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  if (embedding) writeFileSync(join(path, ".kizuki", "serve.toml"), '[ports]\nretrieval = "kizuki.retrieval.embedded-pg"\nembedding = "kizuki.embedding.gguf"\n');
  return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")) };
}

/** Only what the rail touches: the bounded embed pass and health. */
function engine(pass: (limit: number | undefined) => Promise<EmbedProgress>, backlog = 0) {
  const limits: Array<number | undefined> = [];
  const port = {
    descriptor: { id: "test.engine", kind: "retrieval", contract: "kizuki.retrieval/v1", contract_minor: 0, supports: ["lexical", "vector", "hybrid"], requires_lease: false, optional_package: null },
    embedPending: async (options?: { limit?: number }) => { limits.push(options?.limit); return pass(options?.limit); },
    health: async () => ({ status: "ready" as const, detail: { backlog_depth: backlog } }),
  } as unknown as RetrievalPort;
  return { port, limits };
}

const run = (f: ReturnType<typeof vault>, port: RetrievalPort | undefined) =>
  runRail(f.db, f.path, "embed-backfill", {
    hooks: { claims: port === undefined ? { db: f.db } : { db: f.db, retrieval: port }, embedding_configured: true },
  });

describe("embed-backfill drains the engine's backlog", () => {
  test("a pass embeds a bounded batch and receipts the documents and what is left", async () => {
    const f = vault(true);
    const { port, limits } = engine(async () => ({ chunks: 200, documents: 37, remaining: 1_200 }));
    const receipt = await run(f, port);
    expect(limits).toEqual([EMBED_PASS_CHUNKS]);
    expect(receipt.status).toBe("ok");
    expect(receipt.retrieval).toEqual({ upserts: 37, removals: 0, pending_ops: 1_200, degraded: [] });
    expect(listRunReceipts(f.db, { rail: "embed-backfill" })[0]?.retrieval.upserts).toBe(37);
    f.db.close();
  });

  test("an unreachable embedding server degrades the pass and receipts the backlog it could not drain", async () => {
    const f = vault(true);
    const { port } = engine(async () => { throw new PortError("unavailable", "embedding server is unreachable", true); }, 42);
    const receipt = await run(f, port);
    expect(receipt.status).toBe("degraded");
    expect(receipt.retrieval).toEqual({ upserts: 0, removals: 0, pending_ops: 42, degraded: ["embedding-unavailable"] });
    f.db.close();
  });

  test("a fault that is not a port refusal is the rail's own failure", async () => {
    const f = vault(true);
    const { port } = engine(async () => { throw new Error("boom"); });
    const receipt = await run(f, port);
    expect(receipt.status).toBe("failed");
    f.db.close();
  });

  test("without an embedding engine there is no work and nothing to report", async () => {
    const f = vault(false);
    const receipt = await run(f, undefined);
    expect(receipt.status).toBe("ok");
    expect(receipt.retrieval).toEqual(emptyRunTotals().retrieval);
    const lexicalOnly = { descriptor: { id: "test.lexical" }, health: async () => ({ status: "ready" as const, detail: {} }) } as unknown as RetrievalPort;
    expect((await run(f, lexicalOnly)).retrieval).toEqual(emptyRunTotals().retrieval);
    f.db.close();
  });
});
