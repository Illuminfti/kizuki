import { expect, setDefaultTimeout, test } from "bun:test";
import { TOOLS } from "@kizuki/core";
import { revokeSourceGrant } from "../../core/src/ledger/source-grants";
import { worldSeed } from "../../core/test/helpers/world-seed";
import { envelopeOf } from "./client";
import type { ToolCallResult } from "./client";
import { twoClients } from "./helpers/two-clients";

setDefaultTimeout(120_000);
const KEYS = ["at", "canon", "data", "principal", "quoted", "schema", "tool"];
function forbidden(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(forbidden);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(["epoch", "claims_epoch", "source_policy", "denied"].includes(key) ? [key] : []),
    ...forbidden(item),
  ]);
}
function withoutTime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTime);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "at" || key === "validUntil" ? "<time>" : withoutTime(item)]));
}
function stableReply(reply: ToolCallResult): unknown {
  return { ...reply,
    structuredContent: withoutTime(reply.structuredContent),
    content: reply.content.map((part) => ({ ...part, text: JSON.stringify(withoutTime(JSON.parse(part.text))) })),
  };
}

test("a newly enrolled stdio client uses v2 on every tool, and hidden revocation preserves its packet baseline", async () => {
  const clients = await twoClients({ agent: { tools: [...TOOLS], relay_owner_corrections: true } });
  try {
    const hidden = await worldSeed(clients.db, { subject: "topic:hidden", floor: "private", discover: false });
    const read = await clients.readConcept(clients.agent);
    expect(read.card?.schema).toBe("kizuki.envelope/v2");
    const inputs: Record<string, Record<string, unknown>> = {
      search: { query: "Bayesian" }, get_page: { id: "absent:page" }, query_entities: { type: "topic" },
      timeline: { since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" },
      context_packet: { query: "Bayesian", budget_tokens: 1_000 }, graph_neighbors: { id: "absent:page" },
      system_health: {}, world_view: { operation: "describe" },
      propose: { kind: "claim", body: "An ordinary note", subjects: ["topic:bayes"], provenance: [hidden.eventId] },
      correct: { statement: "Use the current definition.", target: { claim_id: hidden.claims[2] }, dry_run: true },
    };
    const before = new Map();
    for (const tool of TOOLS) {
      const result = await clients.agent.call(tool, inputs[tool]!);
      expect(forbidden(result)).toEqual([]);
      expect(forbidden(JSON.parse(result.content[0]!.text))).toEqual([]);
      if (tool === "propose") {
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ message: "provenance outside the grant" });
      }
      if (tool === "system_health") {
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "unsupported_contract", message: "requested contract unavailable" });
      } else if (!result.isError) {
        const envelope = envelopeOf(result);
        expect(Object.keys(envelope).sort()).toEqual(KEYS);
        expect(envelope.schema).toBe("kizuki.envelope/v2");
        expect(JSON.parse(result.content[0]!.text)).toEqual(envelope);
      }
      before.set(tool, result);
    }
    revokeSourceGrant(clients.db, { source_key: hidden.sourceKey, expected_revision: 1, operation_id: "stdio-hidden-revoke" });
    for (const tool of TOOLS) {
      expect(stableReply(await clients.agent.call(tool, inputs[tool]!))).toEqual(stableReply(before.get(tool)));
    }
    const packet = envelopeOf(before.get("context_packet")).data as { result: { view: unknown } };
    const again = await clients.agent.call("context_packet", { ...inputs.context_packet, priorView: packet.result.view });
    expect(envelopeOf(again).data).toMatchObject({ schema: "kizuki.context-packet/v2", result: { status: "unchanged", view: packet.result.view } });
    const owner = await clients.owner.call("context_packet", inputs.context_packet!);
    expect(envelopeOf(owner).schema).toBe("kizuki.envelope/v1");
  } finally { await clients.close(); }
});
