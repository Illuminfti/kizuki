import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, resolveTarget, setGrant } from "@kizuki/core";
import { runBatch } from "../../core/src/ingest/run";
import { listClaims, getClaim } from "../../core/src/claims/store";
import { PAGE_CANDIDATE_KEY, PAGE_CANDIDATE_SCHEMA } from "../../core/src/contracts/page-candidate";
import { validEvent } from "../../core/test/fixtures";
import { call, connectClient, envelopeOf, errorOf } from "./client";
import { mcpFixture, type McpFixture } from "./helpers";

setDefaultTimeout(120_000);
let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

function pageRevision(f: McpFixture, text: string) {
  return runBatch(f.db, {
    events: [{ ...validEvent(), source_record_id: "wiki/atlas.md", subjects: [], text,
      metadata: { [PAGE_CANDIDATE_KEY]: { schema: PAGE_CANDIDATE_SCHEMA, type: "topic",
        title: "Atlas", target: "entities/atlas", extensions: {}, confidence: 1 } } }],
    cursor: null, has_more: false,
  }, { page_candidates: true });
}

test.each([
  ["owner", "claim_id"], ["owner", "claim_key"],
  ["reader-private", "claim_id"], ["reader-private", "claim_key"],
] as const)("MCP %s correct by %s retires a source page and retries idempotently", async (principal, by) => {
  const f = mcpFixture();
  fixture = f;
  const target = "entities/atlas";
  const revision = (text: string) => pageRevision(f, text);
  expect(revision("Original page body").errors).toEqual([]);
  const original = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === target)!;
  expect(original).toBeDefined();
  const io = { db: f.db, vault_path: f.vaultPath };
  const written = applyCanonWrite(io, original, resolveTarget(io, original), {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  const client = await connectClient(principal === "owner" ? f.owner() : f.agent(principal), open);
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

test("MCP page correction honors downgraded relays and hides recorded corrections", async () => {
  const f = mcpFixture();
  fixture = f;
  expect(pageRevision(f, "Original page body").errors).toEqual([]);
  const original = listClaims(f.db, { status: "live", limit: 20 }).find(c => c.target === "entities/atlas")!;
  const io = { db: f.db, vault_path: f.vaultPath };
  const written = applyCanonWrite(io, original, resolveTarget(io, original), {
    writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  const path = join(f.vaultPath, written.page_path);
  const counts = () => ["events", "claims", "claim_supersessions", "canon_receipts"].map(table =>
    f.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  setGrant(f.db, "reader-private", { relay_owner_corrections: false });
  const agent = await connectClient(f.agent("reader-private"), open);
  const relayed = await call(agent, "correct", {
    statement: "Relayed page body", target: { claim_id: original.claim_id },
  });
  expect(relayed.isError ?? false).toBe(false);
  const relayClaim = (envelopeOf(relayed)["data"] as { claim_id: string }).claim_id;
  expect(getClaim(f.db, relayClaim)).toMatchObject({ authority: "owner_authored", claim_key: original.claim_key });
  expect(readFileSync(path, "utf8")).toContain("Relayed page body");
  expect(pageRevision(f, "Later source body").errors).toEqual([]);
  expect(getClaim(f.db, relayClaim)?.status).toBe("live");

  const owner = await connectClient(f.owner(), open);
  const request = { statement: "Corrected page body", target: { claim_id: relayClaim } };
  const accepted = await call(owner, "correct", request);
  expect(accepted.isError ?? false).toBe(false);
  const corrected = (envelopeOf(accepted)["data"] as { claim_id: string }).claim_id;
  const recorded = counts();
  const correctedBytes = readFileSync(path, "utf8");
  const denied = await call(agent, "correct", {
    statement: "Cannot replace owner correction", target: { claim_id: corrected },
  });
  expect(denied.isError).toBe(true);
  expect(errorOf(denied).error).toBe("held");
  expect(counts()).toEqual(recorded);
  expect(readFileSync(path, "utf8")).toBe(correctedBytes);
  // The already-connected session must apply the narrowed grant to retries too.
  setGrant(f.db, "reader-private", { types: ["person"] });
  const replay = await call(agent, "correct", request);
  const hidden = await call(agent, "correct", { ...request, target: { claim_id: corrected } });
  const absent = await call(agent, "correct", { ...request, target: { claim_id: "missing-page-claim" } });
  expect(replay.isError).toBe(true);
  expect(hidden.isError).toBe(true);
  expect(absent.isError).toBe(true);
  expect(replay.content).toEqual(absent.content);
  expect(hidden.content).toEqual(absent.content);
  expect(counts()).toEqual(recorded);
  expect(readFileSync(path, "utf8")).toBe(correctedBytes);
});
