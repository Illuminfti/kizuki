/**
 * The v2 context packet through Core dispatch: what its body and result say,
 * when it answers unchanged, what it refuses, and that its own text is
 * recognized as machine output when it comes back in as a capture.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { OWNER, listAudit } from "../../src/agents";
import { hasContextPacketMarker } from "../../src/canon/origin";
import { accept } from "../../src/ledger/ledger";
import { dispatchServeTool } from "../../src/serving/dispatch";
import type { ContextPacketDataV2 } from "../../src/serving/v2/context-packet";
import { validEvent } from "../fixtures";
import { hiddenScene } from "../helpers/noninterference";
import type { NoninterferenceScene } from "../helpers/noninterference";

setDefaultTimeout(120_000);

const V2 = "kizuki.envelope/v2";
const PACKET = { query: "Bayesian", budget_tokens: 1_000 };
/** Recall of the timeline, over a window that holds the fixtures' capture times. */
const WIDE = { ...PACKET, purpose: "recall", include: ["timeline"], since: "2026-01-01T00:00:00Z", until: "2100-01-01T00:00:00Z" };

async function read(
  scene: NoninterferenceScene,
  args: Record<string, unknown> = PACKET,
  ctx = scene.reader,
) {
  const envelope = await dispatchServeTool(ctx, "context_packet", args, {
    response_contract: V2,
  });
  return { envelope, packet: envelope.data as ContextPacketDataV2 };
}

function visibleCapture(scene: NoninterferenceScene, text: string): void {
  const stored = accept(
    scene.db,
    {
      ...validEvent(),
      connector_id: "world.fixture",
      source_record_id: `visible-${text}`,
      text,
      sensitivity_hint: "public",
      subjects: [{ subject_id: "topic:bayes", role: "about" }],
    },
    {
      source: {
        source_key: scene.visible.concept.sourceKey,
        expected_revision: 1,
      },
    },
  );
  if (stored.status !== "stored")
    throw new Error("the visible capture was not stored");
}

test("the v2 body leads with its marker and names no epoch, time or digest", async () => {
  const scene = await hiddenScene();
  try {
    const { envelope, packet } = await read(scene);
    expect(envelope.schema).toBe(V2);
    expect(packet.schema).toBe("kizuki.context-packet/v2");
    if (packet.result.status !== "current")
      throw new Error(`expected current, got ${packet.result.status}`);
    const { data, view } = packet.result;
    expect(view.kind).toBe("view");
    expect(view.token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    const [marker, header, rules] = data.packetMd.split("\n");
    expect(marker).toBe("KIZUKI CONTEXT v2");
    expect(header).toBe(`principal=narrow-reader purpose=session budget=1000`);
    expect(rules).toStartWith("rules=canon lines are produced prose");
    expect(data.packetMd).not.toMatch(/epoch|\bat=|etag|packet_hash/);
    expect(Object.keys(data).sort()).toEqual([
      "budgetTokens",
      "packetMd",
      "purpose",
      "retrievalDegraded",
      "sections",
      "session",
      "tokenizer",
      "tokens",
      "truncated",
    ]);
    expect(data.tokens).toBeLessThanOrEqual(data.budgetTokens);
    expect(new Date(packet.result.validUntil).getTime()).toBeGreaterThan(
      Date.parse(envelope.at),
    );
  } finally {
    scene.dispose();
  }
});

test("unchanged answers only for a view of the very bytes the caller would be served", async () => {
  const scene = await hiddenScene();
  try {
    const first = (await read(scene, WIDE)).packet.result;
    if (first.status !== "current") throw new Error("expected a current packet");

    const same = await read(scene, { ...WIDE, priorView: first.view });
    expect(same.packet.result).toMatchObject({ status: "unchanged", view: first.view });
    expect(same.packet.result).not.toHaveProperty("data");
    expect(same.envelope.canon).toEqual([]);
    expect(same.envelope.quoted).toEqual([]);

    // A view of some other bytes is not a baseline for these: the caller is served the packet.
    const other = await read(scene, { ...WIDE, priorView: { kind: "view", token: "A".repeat(43) } });
    expect(other.packet.result).toMatchObject({ status: "current", view: first.view });

    visibleCapture(scene, "a Bayesian note the reader may see");
    const moved = await read(scene, { ...WIDE, priorView: first.view });
    expect(moved.packet.result.status).toBe("current");
    if (moved.packet.result.status !== "current") throw new Error("unreachable");
    expect(moved.packet.result.view).not.toEqual(first.view);
    expect(moved.packet.result.data.packetMd).toContain("a Bayesian note the reader may see");
  } finally {
    scene.dispose();
  }
});

test("an incomplete packet is served with its gap and is never unchanged", async () => {
  const scene = await hiddenScene();
  try {
    const first = (await read(scene)).packet.result;
    if (first.status !== "current")
      throw new Error("expected a current packet");
    const degraded = await read(
      scene,
      { ...PACKET, priorView: first.view },
      { ...scene.reader, retrievalUnavailable: true },
    );
    expect(degraded.packet.result).toMatchObject({
      status: "incomplete",
      reasons: ["coverage"],
    });
    if (degraded.packet.result.status !== "incomplete")
      throw new Error("unreachable");
    expect(degraded.packet.result.data.retrievalDegraded).toContain(
      "retrieval-unavailable",
    );
    expect(degraded.packet.result).not.toHaveProperty("view");
  } finally {
    scene.dispose();
  }
});

test("a baseline covers the packet header and metadata as well as its body", async () => {
  const scene = await hiddenScene();
  try {
    const first = (await read(scene, { ...WIDE, include: [] })).packet.result;
    if (first.status !== "current") throw new Error("expected current");
    const changed = (await read(scene, {
      ...WIDE, include: [], budget_tokens: 1_500, priorView: first.view,
    })).packet.result;
    expect(changed.status).toBe("current");
    if (changed.status !== "current") throw new Error("expected current");
    expect(changed.data.budgetTokens).toBe(1_500);
    expect(changed.view).not.toEqual(first.view);
  } finally {
    scene.dispose();
  }
});

test("the v1 baseline keys are refused before anything is read, and the refusal is audited", async () => {
  const scene = await hiddenScene();
  try {
    const legacy: Record<string, unknown> = {
      capabilities: ["delta"],
      retain_prefix: true,
      prior_hash: "0".repeat(64),
      epoch: 0,
    };
    for (const [key, value] of Object.entries(legacy)) {
      await expect(
        dispatchServeTool(
          scene.reader,
          "context_packet",
          { ...PACKET, [key]: value },
          { response_contract: V2 },
        ),
      ).rejects.toMatchObject({
        code: "invalid_arguments",
        message: expect.stringContaining(key),
      });
    }
    const rows = listAudit(scene.db, "narrow-reader", { limit: 10 }).filter(
      (row) => row.tool === "context_packet",
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.served).toEqual([]);
      expect(row.denied).toEqual([
        { id: "tool:context_packet", reason: "invalid_arguments" },
      ]);
    }
  } finally {
    scene.dispose();
  }
});

test("a view that is not a view token is an argument error", async () => {
  const scene = await hiddenScene();
  try {
    for (const priorView of [
      "A".repeat(43),
      { kind: "view" },
      { kind: "view", token: "short" },
      { kind: "object", token: "A".repeat(43) },
      { kind: "view", token: "A".repeat(43), extra: 1 },
      null,
    ]) {
      await expect(
        dispatchServeTool(
          scene.reader,
          "context_packet",
          { ...PACKET, priorView },
          { response_contract: V2 },
        ),
      ).rejects.toMatchObject({ code: "invalid_arguments" });
    }
    // The v1 packet has no such key and never reads it.
    const v1 = await dispatchServeTool({ ...scene.reader, principal: OWNER }, "context_packet", {
      ...PACKET,
      priorView: "ignored",
    });
    expect((v1.data as { packet_md: string }).packet_md).toStartWith(
      "KIZUKI CONTEXT v1\n",
    );
  } finally {
    scene.dispose();
  }
});

test("a v2 packet served back in as capture is machine output, like a v1 packet", async () => {
  const scene = await hiddenScene();
  try {
    const { packet } = await read(scene);
    if (packet.result.status !== "current")
      throw new Error("expected a current packet");
    const text = packet.result.data.packetMd;
    expect(hasContextPacketMarker(text)).toBe(true);
    expect(hasContextPacketMarker("KIZUKI CONTEXT v1\nrules=x")).toBe(true);
    expect(hasContextPacketMarker("KIZUKI CONTEXT v3")).toBe(false);
    const echoed = accept(scene.db, {
      ...validEvent(),
      source_record_id: "v2-echo",
      text,
    });
    if (echoed.status !== "stored") throw new Error("the echo was not stored");
    expect(echoed.event.origin).toBe("self");
    const plain = accept(scene.db, {
      ...validEvent(),
      source_record_id: "plain",
      text: "an ordinary note",
    });
    if (plain.status !== "stored") throw new Error("the note was not stored");
    expect(plain.event.origin).toBe("external");
  } finally {
    scene.dispose();
  }
});
