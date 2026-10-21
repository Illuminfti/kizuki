import { expect } from "bun:test";
import type { CanonChunkV2, QuotedChunkV2 } from "../../core/src/contracts/scoped-tools";
import type { ScopedRef } from "../../core/src/contracts/scoped-refs";
import { referenceScope } from "../../core/src/world/ref-kinds/common";
import { resolvePageRef } from "../../core/src/world/ref-kinds/page";
import { resolveEventVersionRef } from "../../core/src/world/ref-kinds/evidence";
import { resolveClaimRef } from "../../core/src/world/ref-kinds/claim";
import type { ServeContext } from "@kizuki/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";

export interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Every connection a test opens is closed by the caller's `afterEach`: a
 * linked pair left open keeps the fixture's database handle alive.
 */
export async function connectClient(
  ctx: ServeContext,
  open: (() => Promise<void>)[],
): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kizuki-test", version: "0" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } finally {
      await server.close();
    }
  };
  open.push(close);
  let connected = false;
  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    // A real client lists first; that is what builds the SDK's closed output
    // validator. Skipping it never notices a schema narrower than the envelope.
    await client.listTools();
    connected = true;
    return client;
  } finally {
    if (!connected) await close();
  }
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as ToolCallResult;
}

export function envelopeOf(
  result: ToolCallResult,
): Record<string, unknown> {
  return result.structuredContent ?? {};
}

export function errorOf(result: ToolCallResult): { error?: string } {
  return JSON.parse(result.content[0]?.text ?? "{}") as { error?: string };
}

export function pageIds(envelope: Record<string, unknown>): string[] {
  return (envelope["canon"] as { page_id: string }[]).map(
    (chunk) => chunk.page_id,
  );
}

/** Fixture oracle only: resolve actual public capabilities under the same current
 * principal. Never mint refs or use raw identifiers as scoped wire arguments. */
export function resolvedCanon(ctx: ServeContext, envelope: Record<string, unknown>) {
  expect(envelope.schema).toBe("kizuki.envelope/v2");
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx);
    return (envelope.canon as CanonChunkV2[]).map(chunk => {
      expect(chunk).not.toHaveProperty("page_id");
      const page = resolvePageRef(scope, chunk.page);
      expect(page).not.toBeNull();
      const sources = chunk.sources.map(ref => {
        const id = resolveEventVersionRef(scope, ref);
        expect(id).not.toBeNull();
        return id!;
      });
      return { ...chunk, page_id: page!.id, sources };
    });
  }).immediate();
}

export function eventIds(ctx: ServeContext, envelope: Record<string, unknown>): string[] {
  if (ctx.principal.kind === "owner") {
    expect(envelope.schema).toBe("kizuki.envelope/v1");
    return (envelope.quoted as { event_id: string }[]).map(chunk => chunk.event_id);
  }
  expect(envelope.schema).toBe("kizuki.envelope/v2");
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx);
    return (envelope.quoted as QuotedChunkV2[]).map(chunk => {
      expect(chunk).not.toHaveProperty("event_id");
      const id = resolveEventVersionRef(scope, chunk.eventVersion);
      expect(id).not.toBeNull();
      return id!;
    });
  }).immediate();
}

export function claimId(ctx: ServeContext, value: ScopedRef): string {
  return ctx.db.transaction(() => {
    const claim = resolveClaimRef(referenceScope(ctx), value);
    expect(claim).not.toBeNull();
    return claim!.claim_id;
  }).immediate();
}

export async function captured(client: Client): Promise<QuotedChunkV2> {
  const result = await call(client, "timeline", { day: "2026-02-28" });
  expect(result.isError).toBeUndefined();
  expect(envelopeOf(result).schema).toBe("kizuki.envelope/v2");
  const chunk = (envelopeOf(result).quoted as QuotedChunkV2[])[0];
  expect(chunk).toBeDefined();
  return chunk!;
}
