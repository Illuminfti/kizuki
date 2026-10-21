import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, getCanonReceipt, resolveTarget, setGrant } from "@kizuki/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ScopedRef } from "../../core/src/contracts/scoped-refs";
import type { CorrectDataV2 } from "../../core/src/contracts/scoped-tools";
import type { ServeContext } from "@kizuki/core";
import { referenceScope } from "../../core/src/world/ref-kinds/common";
import { resolveReceiptRef } from "../../core/src/world/ref-kinds/receipt";
import { runBatch } from "../../core/src/ingest/run";
import { listClaims, getClaim } from "../../core/src/claims/store";
import { PAGE_CANDIDATE_KEY, PAGE_CANDIDATE_SCHEMA } from "../../core/src/contracts/page-candidate";
import { validEvent } from "../../core/test/fixtures";
import { call, connectClient, envelopeOf, errorOf, claimId } from "./client";
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

// Obtain the same public claim capability a scoped consumer can submit. The
// fixture resolver checks its identity; it never grants or manufactures a ref.
async function claimFromPacket(client: Client, ctx: ServeContext, id: string): Promise<ScopedRef<"claim">> {
  const packet = await call(client, "context_packet", { purpose: "correction", include: ["claims"], budget_tokens: 2000 });
  expect(packet.isError).toBeUndefined();
  const data = envelopeOf(packet).data as { result: { data: { packetMd: string } } };
  const refs = [...data.result.data.packetMd.matchAll(/^- \[claim-ref:([A-Za-z0-9_-]{43})\] quoted claim$/gm)]
    .map(match => ({ kind: "claim" as const, token: match[1]! }));
  const ref = refs.find(value => claimId(ctx, value) === id);
  expect(ref).toBeDefined();
  return ref!;
}

function scopedCorrection(ctx: ServeContext, result: ReturnType<typeof envelopeOf>) {
  expect(result.schema).toBe("kizuki.envelope/v2");
  const data = result.data as CorrectDataV2;
  for (const field of ["claim_id", "event_id", "receipt_id"]) expect(data).not.toHaveProperty(field);
  expect(data.claim).not.toBeNull();
  expect(data.receipt).not.toBeNull();
  const receipt = ctx.db.transaction(() => resolveReceiptRef(referenceScope(ctx), data.receipt!)).immediate();
  expect(receipt).not.toBeNull();
  for (const rewrite of data.rewritten) {
    expect(rewrite.diff).toEqual({ status: "unavailable" });
    expect(rewrite).not.toHaveProperty("before_hash");
    expect(rewrite).not.toHaveProperty("after_hash");
  }
  return { data, receipt: receipt!, id: claimId(ctx, data.claim!) };
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
  const ctx = principal === "owner" ? f.owner() : f.agent(principal);
  const client = await connectClient(ctx, open);
  const legacy = { statement: "Corrected page body", target: by === "claim_id"
    ? { claim_id: original.claim_id } : { claim_key: original.claim_key! } };
  if (principal !== "owner") {
    const refused = await call(client, "correct", legacy);
    expect(errorOf(refused).error).toBe("invalid_arguments");
    expect(getClaim(f.db, original.claim_id)?.status).toBe("live");
    expect(readFileSync(join(f.vaultPath, written.page_path), "utf8")).toContain("Original page body");
  }
  const request = principal === "owner" ? legacy : {
    statement: legacy.statement, target: await claimFromPacket(client, ctx, original.claim_id),
  };
  const result = await call(client, "correct", request);
  expect(result.isError ?? false).toBe(false);
  const raw = envelopeOf(result).data as { event_id: string; claim_id: string; superseded: { claim_id: string }[];
    rewritten: { receipt_id: string; before_hash: string | null; after_hash: string }[] };
  const scoped = principal === "owner" ? null : scopedCorrection(ctx, envelopeOf(result));
  const correctedId = scoped?.id ?? raw.claim_id;
  const rewritten = scoped?.data.rewritten ?? raw.rewritten;
  expect(rewritten).toHaveLength(1);
  const receipt = scoped?.receipt ?? getCanonReceipt(f.db, raw.rewritten[0]!.receipt_id)!;
  expect(receipt).not.toBeNull();
  if (principal === "owner") {
    expect(raw.rewritten[0]!.before_hash).toBe(receipt.before_hash);
    expect(raw.rewritten[0]!.after_hash).toBe(receipt.after_hash);
  } else {
    expect(JSON.stringify(result)).not.toContain(receipt.before_hash!);
    expect(JSON.stringify(result)).not.toContain(receipt.after_hash);
  }
  expect(scoped?.data.superseded.map(ref => claimId(ctx, ref)) ?? raw.superseded.map(c => c.claim_id)).toContain(original.claim_id);
  expect(getClaim(f.db, correctedId)?.claim_key).toBe(original.claim_key);
  const path = join(f.vaultPath, written.page_path);
  const bytes = readFileSync(path, "utf8");
  expect(bytes).toContain("Corrected page body");
  expect(bytes).not.toContain("Original page body");
  const repeated = await call(client, "correct", request);
  expect(repeated.isError ?? false).toBe(false);
  if (scoped === null) {
    expect(envelopeOf(repeated).data).toMatchObject({ claim_id: correctedId, event_id: raw.event_id });
  } else {
    expect(envelopeOf(repeated).data).toMatchObject({ claim: scoped.data.claim, eventVersion: scoped.data.eventVersion });
    expect(claimId(ctx, (envelopeOf(repeated).data as CorrectDataV2).claim!)).toBe(correctedId);
  }
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(revision("Later source body").errors).toEqual([]);
  expect(getClaim(f.db, correctedId)?.status).toBe("live");
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
  const agentCtx = f.agent("reader-private");
  const originalRef = await claimFromPacket(agent, agentCtx, original.claim_id);
  const relayed = await call(agent, "correct", {
    statement: "Relayed page body", target: originalRef,
  });
  expect(relayed.isError ?? false).toBe(false);
  const relay = scopedCorrection(agentCtx, envelopeOf(relayed));
  const relayClaim = relay.id;
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
  const correctedRef = await claimFromPacket(agent, agentCtx, corrected);
  const denied = await call(agent, "correct", {
    statement: "Cannot replace owner correction", target: correctedRef,
  });
  expect(denied.isError).toBe(true);
  expect(errorOf(denied).error).toBe("held");
  expect(counts()).toEqual(recorded);
  expect(readFileSync(path, "utf8")).toBe(correctedBytes);
  // The already-connected session must apply the narrowed grant to retries too.
  setGrant(f.db, "reader-private", { types: ["person"] });
  const replay = await call(agent, "correct", { statement: "Relayed page body", target: originalRef });
  const hidden = await call(agent, "correct", { statement: request.statement, target: correctedRef });
  const absent = await call(agent, "correct", { statement: request.statement, target: { kind: "claim", token: "A".repeat(43) } });
  expect(replay.isError).toBe(true);
  expect(hidden.isError).toBe(true);
  expect(absent.isError).toBe(true);
  expect(replay.content).toEqual(absent.content);
  expect(hidden.content).toEqual(absent.content);
  expect(counts()).toEqual(recorded);
  expect(readFileSync(path, "utf8")).toBe(correctedBytes);
});
