import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildMinimalSafetensorsBuffer,
  createMemtEngine,
  defaultMemtSnapshotDir,
  MemtEngine,
} from "@kizuki/memt";
import { createServer } from "../src/server";
import { call, envelopeOf, errorOf } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: McpFixture | null = null;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

async function connectWithMemt(
  ctx: ReturnType<McpFixture["owner"]>,
  memtEngine?: MemtEngine,
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(ctx, memtEngine === undefined ? {} : { memtEngine });
  const client = new Client({ name: "memt-test-client", version: "1.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function payloadOf(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("MemT-1.0 MCP tools & context_packet integration", () => {
  test("memt_status reports local-hybrid mode, redacts GPU url for scoped agents, and reflects in system_health v2", async () => {
    const running = live();
    const ownerClient = await connectWithMemt(running.owner());
    const agentClient = await connectWithMemt(running.agent("reader-personal"));

    const ownerStatus = payloadOf(await call(ownerClient, "memt_status", {}));
    expect(ownerStatus["schema"]).toBe("kizuki.memt-status/v1");
    expect(ownerStatus["mode"]).toBe("local-hybrid");
    expect("url" in ownerStatus).toBe(true);

    const agentStatus = payloadOf(await call(agentClient, "memt_status", {}));
    expect(agentStatus["schema"]).toBe("kizuki.memt-status/v1");
    expect(agentStatus["ceiling"]).toBe("personal");
    expect("url" in agentStatus).toBe(false);

    const health = envelopeOf(await call(agentClient, "system_health", {}));
    expect(health["schema"]).toBe("kizuki.envelope/v2");
    const memtData = (health["data"] as { memt: { enabled: boolean; mode: string; status: string } }).memt;
    expect(memtData.enabled).toBe(true);
    expect(memtData.mode).toBe("local-hybrid");
    expect(memtData.status).toBe("ready");
  });

  test("memt_experience enforces caller sensitivity ceiling, permissions, and verification", async () => {
    const running = live();
    const ownerClient = await connectWithMemt(running.owner());
    const personalClient = await connectWithMemt(running.agent("reader-personal"));
    const searchOnlyClient = await connectWithMemt(running.agent("search-only"));

    // Owner records one private and one personal procedural experience
    const privRec = payloadOf(
      await call(ownerClient, "memt_experience", {
        action: "record",
        domain: "ops",
        scope_key: "kettle",
        sensitivity: "private",
        condition: "private secret kettle procedure",
        recommendation: "keep hidden from personal ceiling",
        outcome: "verified",
        confidence: 0.95,
      }),
    );
    expect((privRec["experience"] as { sensitivity: string }).sensitivity).toBe("private");

    const pubRec = payloadOf(
      await call(personalClient, "memt_experience", {
        action: "record",
        domain: "ops",
        scope_key: "kettle",
        sensitivity: "personal",
        condition: "kettle steam valve drifts",
        recommendation: "recalibrate kettle thermal loop",
        outcome: "observed",
        confidence: 0.85,
        citations: [running.eventId],
      }),
    );
    const personalId = (pubRec["experience"] as { id: string }).id;

    // Personal agent cannot record above its ceiling
    const escalated = await call(personalClient, "memt_experience", {
      action: "record",
      domain: "ops",
      sensitivity: "private",
      condition: "escalate",
      recommendation: "should fail",
    });
    expect(escalated.isError).toBe(true);
    expect(errorOf(escalated).error).toBe("tool_not_granted");

    // search-only lacks propose, cannot record
    const ungranted = await call(searchOnlyClient, "memt_experience", {
      action: "record",
      domain: "ops",
      condition: "nope",
      recommendation: "nope",
    });
    expect(ungranted.isError).toBe(true);
    expect(errorOf(ungranted).error).toBe("tool_not_granted");

    // Personal search sees personal experience, never private experience
    const found = payloadOf(
      await call(personalClient, "memt_experience", {
        action: "search",
        query: "kettle",
        limit: 10,
      }),
    );
    const hits = found["hits"] as { experience: { id: string; sensitivity: string } }[];
    expect(hits.some((h) => h.experience.id === personalId)).toBe(true);
    expect(hits.every((h) => h.experience.sensitivity !== "private")).toBe(true);

    // Personal agent cannot verify private experience (must return not_found)
    const verifyPrivate = await call(personalClient, "memt_experience", {
      action: "verify",
      id: (privRec["experience"] as { id: string }).id,
      outcome: "verified",
    });
    expect(verifyPrivate.isError).toBe(true);
    expect(errorOf(verifyPrivate).error).toBe("not_found");

    // Personal agent can verify its own visible experience
    const verified = payloadOf(
      await call(personalClient, "memt_experience", {
        action: "verify",
        id: personalId,
        outcome: "verified",
        verification: "confirmed steady temp",
      }),
    );
    expect((verified["experience"] as { outcome: string }).outcome).toBe("verified");
  });

  test("memt_recall fuses Kizuki exact evidence + MemT experiences while preserving taint & ceiling", async () => {
    const running = live();
    const ownerClient = await connectWithMemt(running.owner());
    const personalClient = await connectWithMemt(running.agent("reader-personal"));

    await call(ownerClient, "memt_experience", {
      action: "record",
      domain: "thermal",
      sensitivity: "public",
      condition: "kettle runs cold during startup",
      recommendation: "preheat kettle coil for 30s before brewing",
      outcome: "verified",
      confidence: 0.92,
      citations: [running.eventId],
    });

    const recalled = payloadOf(
      await call(personalClient, "memt_recall", {
        query: "kettle",
        scope: "all",
        limit: 10,
      }),
    );
    expect(recalled["schema"]).toBe("kizuki.memt-recall/v1");
    expect(recalled["ceiling"]).toBe("personal");
    const items = recalled["items"] as {
      source: string;
      kind: string;
      taint: string;
      trust_tag: string;
      untrusted_captured_text: boolean;
      sensitivity: string;
    }[];
    expect(items.some((i) => i.source === "experience" && i.trust_tag === "verified_procedure")).toBe(true);
    expect(items.some((i) => i.source === "system2")).toBe(true);
    expect(items.every((i) => i.sensitivity !== "private")).toBe(true);
    for (const ev of items.filter((i) => i.kind === "event")) {
      expect(ev.taint).toBe("quoted");
      expect(ev.untrusted_captured_text).toBe(true);
      expect(ev.trust_tag).toBe("untrusted_captured_text");
    }
  });

  test("memt_snapshot checks custody, rejects purged_invalidated, and context_packet appends procedural memory", async () => {
    const running = live();
    const engine = createMemtEngine(running.vaultPath);
    cleanups.push(() => engine.close());

    engine.experiences.recordExperience({
      domain: "kettle-ops",
      scope_key: "ada",
      sensitivity: "public",
      condition: "Ada checks the kettle status",
      recommendation: "verify kettle lid seal and temperature gauge",
      outcome: "verified",
      confidence: 0.94,
      citations: [running.eventId],
    });

    const snapDir = defaultMemtSnapshotDir(running.vaultPath);
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    const snapBytes = buildMinimalSafetensorsBuffer({ identity: "sha-test-1" });
    writeFileSync(join(snapDir, "ops.safetensors"), snapBytes);
    engine.snapshots.registerSnapshot({
      partition_key: "ops-clean",
      sensitivity_ceiling: "public",
      source_ids: [running.eventId],
      snapshot_name: "ops.safetensors",
      identity_sha256: "sha-test-1",
      event_watermark: "2026-03-01T00:00:00Z",
      taint_state: "clean",
    });

    const personalClient = await connectWithMemt(running.agent("reader-personal"), engine);

    const checkClean = payloadOf(
      await call(personalClient, "memt_snapshot", {
        action: "check",
        partition_key: "ops-clean",
      }),
    );
    expect(checkClean["loadable"]).toBe(true);
    expect(checkClean["validation_ok"]).toBe(true);
    expect("snapshot_path" in checkClean).toBe(false);

    // Purging source invalidates snapshot custody immediately
    engine.purgeSources([running.eventId]);
    const checkPurged = payloadOf(
      await call(personalClient, "memt_snapshot", {
        action: "check",
        partition_key: "ops-clean",
      }),
    );
    expect(checkPurged["loadable"]).toBe(false);
    expect(checkPurged["code"]).toBe("purged_invalidated");

    // Re-add high-confidence experience and verify context_packet v2 appends Procedural Memory within budget
    engine.experiences.recordExperience({
      domain: "kettle-ops",
      scope_key: "ada",
      sensitivity: "public",
      condition: "kettle session startup",
      recommendation: "check Ada kettle readiness checklist",
      outcome: "verified",
      confidence: 0.95,
    });
    const packetRes = envelopeOf(
      await call(personalClient, "context_packet", {
        purpose: "recall",
        query: "kettle readiness",
        budget_tokens: 1000,
      }),
    );
    const packetData = packetRes["data"] as {
      result: { status: string; data: { packetMd: string; tokens: number; budgetTokens: number } };
    };
    expect(["current", "incomplete"]).toContain(packetData.result.status);
    expect(packetData.result.data.packetMd).toContain("## Procedural Memory (MemT-1.0)");
    expect(packetData.result.data.packetMd).toContain("check Ada kettle readiness checklist");
    expect(packetData.result.data.tokens).toBeLessThanOrEqual(packetData.result.data.budgetTokens);
  });
});
