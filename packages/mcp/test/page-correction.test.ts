import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, resolveTarget } from "@kizuki/core";
import { runBatch } from "../../core/src/ingest/run";
import { listClaims, getClaim } from "../../core/src/claims/store";
import { PAGE_CANDIDATE_KEY, PAGE_CANDIDATE_SCHEMA } from "../../core/src/contracts/page-candidate";
import { validEvent } from "../../core/test/fixtures";
import { call, connectClient, envelopeOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

setDefaultTimeout(120_000);
let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

test.each(["claim_id", "claim_key"] as const)("MCP correct by %s retires a source page and retries idempotently", async (by) => {
  const f = mcpFixture();
  fixture = f;
  const target = "entities/atlas";
  const revision = (text: string) => runBatch(f.db, {
    events: [{ ...validEvent(), source_record_id: "wiki/atlas.md", subjects: [], text,
      metadata: { [PAGE_CANDIDATE_KEY]: { schema: PAGE_CANDIDATE_SCHEMA, type: "topic",
        title: "Atlas", target, extensions: {}, confidence: 1 } } }],
    cursor: null, has_more: false,
  }, { page_candidates: true });
  expect(revision("Original page body").errors).toEqual([]);
  const original = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === target)!;
  expect(original).toBeDefined();
  const io = { db: f.db, vault_path: f.vaultPath };
  const written = applyCanonWrite(io, original, resolveTarget(io, original), {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  const client = await connectClient(f.owner(), open);
  const request = { statement: "Corrected page body", target: by === "claim_id"
    ? { claim_id: original.claim_id } : { claim_key: original.claim_key! } };
  const result = await call(client, "correct", request);
  expect(result.isError ?? false).toBe(false);
  const data = envelopeOf(result)["data"] as { event_id: string; claim_id: string; superseded: { claim_id: string }[] };
  expect(data.superseded.map(c => c.claim_id)).toContain(original.claim_id);
  expect(getClaim(f.db, data.claim_id)?.claim_key).toBe(original.claim_key);
  const path = join(f.vaultPath, written.page_path);
  const bytes = readFileSync(path, "utf8");
  expect(bytes).toContain("Corrected page body");
  expect(bytes).not.toContain("Original page body");
  const repeated = await call(client, "correct", request);
  expect(repeated.isError ?? false).toBe(false);
  expect((envelopeOf(repeated)["data"] as { claim_id: string }).claim_id).toBe(data.claim_id);
  expect((envelopeOf(repeated)["data"] as { event_id: string }).event_id).toBe(data.event_id);
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(revision("Later source body").errors).toEqual([]);
  expect(getClaim(f.db, data.claim_id)?.status).toBe("live");
  expect(listClaims(f.db, { status: "live", limit: 20 }).filter(c => c.claim_key === original.claim_key)).toHaveLength(1);
  expect(readFileSync(path, "utf8")).toBe(bytes);
});
