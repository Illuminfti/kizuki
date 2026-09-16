import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openEmbeddedRetrievalPort } from "../src/port";
import {
  FIXTURE_SPACE,
  FixtureEmbeddingPort,
  SYNTHETIC_DOCS,
  SYNTHETIC_QUERY,
  temporaryPortContext,
} from "./helpers";

const NEXT_SPACE = { ...FIXTURE_SPACE, id: "fixture:hash-v2@8", model: "hash-v2" };

function engineSpace(dataDir: string): string | null {
  return (JSON.parse(readFileSync(join(dataDir, "engine.json"), "utf8")) as { space: string | null }).space;
}

async function vectorHits(port: Awaited<ReturnType<typeof openEmbeddedRetrievalPort>>, spaceId: string) {
  const result = await port.search({ ...SYNTHETIC_QUERY, mode: "vector" });
  expect(result.space).toBe(spaceId);
  expect(result.degraded).not.toContain("embedding-space-mismatch");
  return result.hits.map((hit) => hit.doc_id).sort();
}

test("changing embedding space is a full re-embed; a failed rebuild keeps the previous generation", async () => {
  const fixture = temporaryPortContext();
  const docs = [SYNTHETIC_DOCS[0]!, SYNTHETIC_DOCS[1]!];
  const original = new FixtureEmbeddingPort(FIXTURE_SPACE);
  const first = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: original });
  try {
    await first.rebuildFromDocuments(docs);
    expect(engineSpace(fixture.ctx.data_dir)).toBe(FIXTURE_SPACE.id);
    expect(await vectorHits(first, FIXTURE_SPACE.id)).toEqual(["claim:grace-email", "page:grace"]);
    expect((await first.health()).status).toBe("ready");
  } finally {
    await first.close();
  }

  const failing = new FixtureEmbeddingPort(NEXT_SPACE);
  failing.failAfter = 0;
  const interrupted = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: failing });
  try {
    await expect(interrupted.rebuildFromDocuments(docs)).rejects.toThrow("embedder killed");
    expect(engineSpace(fixture.ctx.data_dir)).toBe(FIXTURE_SPACE.id);
  } finally {
    await interrupted.close();
  }

  const retained = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: original });
  try {
    expect(await vectorHits(retained, FIXTURE_SPACE.id)).toEqual(["claim:grace-email", "page:grace"]);
  } finally {
    await retained.close();
  }

  const next = new FixtureEmbeddingPort(NEXT_SPACE);
  const rebuilt = await openEmbeddedRetrievalPort(fixture.ctx, { embedding: next });
  try {
    await rebuilt.rebuildFromDocuments(docs);
    expect(engineSpace(fixture.ctx.data_dir)).toBe(NEXT_SPACE.id);
    expect(await vectorHits(rebuilt, NEXT_SPACE.id)).toEqual(["claim:grace-email", "page:grace"]);
    const health = await rebuilt.health();
    expect(health.status).toBe("ready");
    if (health.status === "ready") expect(health.detail.backlog_depth).toBe(0);
  } finally {
    await rebuilt.close();
    fixture.cleanup();
  }
});
