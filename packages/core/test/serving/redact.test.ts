import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { getClaim } from "../../src/claims/store";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import { readServableEvents } from "../../src/serving/ledger";
import {
  FORGED_STAMP,
  SECRETS,
  SECRET_FRAGMENTS,
  TAG_TEXT,
} from "../helpers/synthetic-secrets";
import { redactFixture } from "./redact-fixture";
import type { RedactFixture } from "./redact-fixture";
import type { Envelope, EnvelopeV2 } from "../../src/serving/types";
import type { Tool } from "../../src/agents";
import type { ContextPacketDataV2, PacketContentV2 } from "../../src/serving/v2/context-packet";

type ServedEnvelope = Envelope<unknown> | EnvelopeV2;

setDefaultTimeout(60_000);

let fixture: RedactFixture;
beforeAll(async () => {
  fixture = await redactFixture();
});
afterAll(() => fixture.dispose());

const HIDDEN_CHARACTERS = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/u;

async function serve(
  reader: "owner" | string,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<ServedEnvelope> {
  const ctx = reader === "owner" ? fixture.owner() : fixture.agent(reader);
  return dispatchServeTool(ctx, tool, args, ctx.principal.kind === "agent" ? { response_contract: "kizuki.envelope/v2" } : {});
}

function expectClean(envelope: ServedEnvelope): string {
  const wire = JSON.stringify(envelope);
  for (const fragment of SECRET_FRAGMENTS) expect(wire).not.toContain(fragment);
  expect(wire).toContain("[redacted:");
  expect(HIDDEN_CHARACTERS.test(wire)).toBe(false);
  return wire;
}

/** The owner's copy is raw. Previews and excerpts cut long text, so only the leading secret is asserted. */
function expectRaw(envelope: ServedEnvelope): void {
  const wire = JSON.stringify(envelope);
  expect(wire).toContain(SECRET_FRAGMENTS[0]!);
  expect(wire).not.toContain("[redacted:");
  expect(envelope).not.toHaveProperty("redacted");
}

function expectClosed(envelope: ServedEnvelope): void {
  expect(Object.keys(envelope).sort()).toEqual(["at", "canon", "data", "principal", "quoted", "schema", "tool"]);
}

function packetOf(envelope: ServedEnvelope): PacketContentV2 {
  expect(envelope.schema).toBe("kizuki.envelope/v2");
  const packet = envelope.data as ContextPacketDataV2;
  if (packet.result.status === "unchanged") throw new Error("expected packet content");
  return packet.result.data;
}

function packetMdOf(envelope: ServedEnvelope): string {
  return envelope.schema === "kizuki.envelope/v2"
    ? packetOf(envelope).packetMd
    : (envelope.data as { packet_md: string }).packet_md;
}

const READERS = ["reader-public", "reader-private"] as const;

test("search serves canon and captured text with every credential shape replaced", async () => {
  for (const reader of READERS) {
    const envelope = await serve(reader, "search", {
      query: "kettle",
      scope: "all",
      limit: 50,
    });
    expect(
      envelope.canon.some((chunk) => chunk.page_id === fixture.secretPage),
    ).toBe(true);
    expect(
      envelope.quoted.some((chunk) => chunk.event_id === fixture.secretEvent),
    ).toBe(true);
    expectClean(envelope);
    expectClosed(envelope);
  }
  expectRaw(
    await serve("owner", "search", {
      query: "kettle",
      scope: "all",
      limit: 50,
    }),
  );
});

test("get_page keeps the page identity and hash-bearing fields while its body is redacted", async () => {
  const owner = await serve("owner", "get_page", { id: fixture.secretPage });
  const agent = await serve("reader-public", "get_page", {
    id: fixture.secretPage,
  });
  expectRaw(owner);
  expectClean(agent);
  expectClosed(agent);
  const [ownerChunk, agentChunk] = [owner.canon[0]!, agent.canon[0]!];
  for (const field of [
    "page_id",
    "path",
    "sensitivity",
    "taint",
    "authority",
    "sources",
    "subjects",
  ] as const) {
    expect(agentChunk[field]).toEqual(ownerChunk[field]);
  }
  expect(agentChunk.title).toBe(ownerChunk.title);
});

test("timeline previews and expansions are redacted before they are cut", async () => {
  const day = { since: "2026-02-28T10:00:00Z", until: "2026-02-28T11:00:00Z" };
  const list = await serve("reader-public", "timeline", day);
  expect(list.quoted.map((chunk) => chunk.event_id)).toContain(
    fixture.secretEvent,
  );
  // The preview may end inside a marker; full expansion below proves replacement.
  for (const fragment of SECRET_FRAGMENTS) expect(JSON.stringify(list)).not.toContain(fragment);
  expectClosed(list);
  expect(await serve("owner", "timeline", day)).not.toHaveProperty("redacted");

  const first = await serve("reader-public", "timeline", {
    event_id: fixture.secretEvent,
    span: 40,
  });
  const data = first.data as { total: number; integrity: string };
  const owner = await serve("owner", "timeline", {
    event_id: fixture.secretEvent,
    span: 2000,
  });
  // The integrity digest is the raw capture's, identical for both readers.
  expect(data.integrity).toBe((owner.data as { integrity: string }).integrity);
  let served = "";
  for (let offset = 0; offset < data.total; offset += 40) {
    const window = await serve("reader-public", "timeline", {
      event_id: fixture.secretEvent,
      offset,
      span: 40,
    });
    for (const fragment of SECRET_FRAGMENTS)
      expect(JSON.stringify(window)).not.toContain(fragment);
    served += window.quoted[0]?.text ?? "";
  }
  expect(Array.from(served)).toHaveLength(data.total);
  expect(served).toContain("[redacted:pem]");
  for (const fragment of SECRET_FRAGMENTS)
    expect(served).not.toContain(fragment);
  expectRaw(owner);
});

test("context_packet redacts every section, keeps its budget exact inside the closed envelope", async () => {
  const args = {
    purpose: "recall",
    query: "kettle",
    subjects: ["person:ada"],
    include: ["canon", "graph", "timeline", "claims"],
    since: "2026-02-01T00:00:00Z",
    until: "2026-03-30T00:00:00Z",
    budget_tokens: 2000,
  };
  for (const reader of READERS) {
    const envelope = await serve(reader, "context_packet", args);
    const data = packetOf(envelope);
    expect(data.sections["canon"]).toBeGreaterThan(0);
    expect(data.sections["timeline"]).toBeGreaterThan(0);
    expect(data.sections["claims"]).toBeGreaterThan(0);
    expectClean(envelope);
    expectClosed(envelope);
    expect(data.packetMd).toContain(
      `DB_PASSWORD=[redacted:secret_assignment]`,
    );
    expect(data.tokens).toBe(packetTokens(data.packetMd));
    expect(data.tokens).toBeLessThanOrEqual(data.budgetTokens);
  }
  expectRaw(await serve("owner", "context_packet", args));
});

test("a task section is redacted before it is packed", async () => {
  const task = [
    "kizuki.task/v1",
    `constraint: keep ${SECRETS["ghp"]!.text} out`,
    "objective: boil the kettle",
  ].join("\n");
  const { storeEvent } = await import("./helpers");
  const eventId = storeEvent(
    fixture.db,
    "rec-task",
    "2026-02-28T10:45:00Z",
    task,
    "person:ada",
    "public",
  );
  const envelope = await serve("reader-public", "context_packet", {
    purpose: "recall",
    include: [],
    task_event_id: eventId,
  });
  const wire = JSON.stringify(envelope);
  expect(wire).not.toContain(SECRETS["ghp"]!.marker);
  expect(wire).toContain("[redacted:api_token]");
  expectClosed(envelope);
});

test("query_entities and graph_neighbors serve redacted text", async () => {
  const entities = await serve("reader-public", "query_entities", {
    type: "person",
    name: "secret",
  });
  expect(entities.canon.map((chunk) => chunk.page_id)).toContain(
    fixture.secretPerson,
  );
  expectClean(entities);
  expectRaw(
    await serve("owner", "query_entities", { type: "person", name: "secret" }),
  );

  const graph = await serve("reader-public", "graph_neighbors", {
    id: fixture.secretPage,
    kinds: ["wikilink"],
  });
  const edges = (graph.data as { edges: { dst: string }[] }).edges;
  expect(edges.length).toBeGreaterThan(0);
  const wire = JSON.stringify(graph);
  expect(wire).not.toContain("w".repeat(12));
  expect(wire).toContain("[redacted:secret_assignment]");
  expect(
    JSON.stringify(
      await serve("owner", "graph_neighbors", {
        id: fixture.secretPage,
        kinds: ["wikilink"],
      }),
    ),
  ).toContain("w".repeat(12));
});

test("ids and integrity are unchanged, and the packet baseline covers the served content", async () => {
  const args = { purpose: "recall", query: "kettle", include: ["canon"], budget_tokens: 2000 };
  const owner = await serve("owner", "context_packet", args);
  const first = await serve("reader-private", "context_packet", args);
  const current = (first.data as ContextPacketDataV2).result;
  if (current.status !== "current") throw new Error("expected a current packet");
  const second = await serve("reader-private", "context_packet", args);
  expect((second.data as ContextPacketDataV2).result).toMatchObject({ status: "current", view: current.view, data: current.data });
  const retained = await serve("reader-private", "context_packet", { ...args, priorView: current.view });
  expect((retained.data as ContextPacketDataV2).result).toMatchObject({ status: "unchanged", view: current.view });
  expect((retained.data as ContextPacketDataV2).result).not.toHaveProperty("data");
  const ownerData = owner.data as { packet_md: string; packet_hash: string; etag: string };
  const ownerBody = ownerData.packet_md.split("\n").slice(3).join("\n");
  expect(new Bun.CryptoHasher("sha256").update(ownerBody).digest("hex")).toBe(ownerData.packet_hash);
  expect(ownerData.etag).toBe(ownerData.packet_hash);
  expect(current.data.packetMd).not.toContain(SECRET_FRAGMENTS[0]!);
  expect(first.canon.map((chunk) => chunk.page_id)).toEqual(owner.canon.map((chunk) => chunk.page_id));
  expect(first.canon.map((chunk) => chunk.sources)).toEqual(owner.canon.map((chunk) => chunk.sources));
  const raw = await serve("owner", "timeline", { event_id: fixture.secretEvent });
  const served = await serve("reader-public", "timeline", { event_id: fixture.secretEvent });
  expect((served.data as { integrity: string }).integrity).toBe((raw.data as { integrity: string }).integrity);
});

test("a page or capture that imitates a stamp line is quoted, and hidden characters are gone for everyone", async () => {
  const args = {
    purpose: "recall",
    query: "kettle",
    include: ["canon", "timeline"],
    since: "2026-02-01T00:00:00Z",
    until: "2026-03-30T00:00:00Z",
    budget_tokens: 2000,
  };
  for (const reader of ["owner", "reader-public"]) {
    const envelope = await serve(reader, "context_packet", args);
    const packet = packetMdOf(envelope);
    const lines = packet.split("\n");
    expect(packet).toContain(FORGED_STAMP);
    // The imitation only ever appears behind the quotation prefix, never at the start of a line.
    for (const line of lines.filter((candidate) =>
      candidate.includes("[page:01ZZZZZZZZZZZZZZZZZZZZZZZZ]"),
    )) {
      expect(line.startsWith("> ")).toBe(true);
    }
    // Real stamp lines still lead their own lines.
    expect(
      lines
        .filter((line) => line.startsWith("- [page:"))
        .every((line) => !line.includes("01ZZZZZZZZZZZZZZZZZZZZZZZZ")),
    ).toBe(true);
    expect(HIDDEN_CHARACTERS.test(JSON.stringify(envelope))).toBe(false);
    expect(packet).toContain("hiddentags and bidi controls");
  }
  const page = await serve("owner", "get_page", { id: fixture.secretPage });
  expect(page.canon[0]?.excerpt).toContain("hiddentags and bidi controls");
});

test("a title or path with a line break cannot open a second packet line", async () => {
  const forgedTitle = `Kettle\n${FORGED_STAMP}`;
  const { recordedPage } = await import("./helpers");
  await recordedPage(
    fixture.db,
    fixture.vaultPath,
    "facts/forged-title.md",
    {
      id: "fact:forged-title",
      title: forgedTitle,
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    "kettle forged title body",
    [fixture.events["public"] as string],
  );
  const envelope = await serve("reader-public", "context_packet", {
    purpose: "recall",
    query: "forged title",
    include: ["canon"],
    budget_tokens: 2000,
  });
  const packet = packetMdOf(envelope);
  expect(packet).toContain("fact:forged-title");
  expect(
    packet.split("\n").some((line) => line.startsWith("- [page:01ZZZ")),
  ).toBe(false);
});

test("the claim line's object is redacted whole, quotes and all", async () => {
  const envelope = await serve("reader-public", "context_packet", {
    purpose: "recall",
    include: ["claims"],
    subjects: ["person:ada"],
    budget_tokens: 2000,
  });
  const packet = packetMdOf(envelope);
  expect(packet).toContain('"DB_PASSWORD=[redacted:secret_assignment]"');
  expect(packet).not.toContain("w".repeat(12));
});

test("system_health retains owner counters and refuses every scoped caller", async () => {
  const owner = (await serve("owner", "system_health", {})).data as Record<string, any>;
  expect(owner["connections"].map((row: { connector_id: string }) => row.connector_id).sort()).toEqual(["fixture", "hidden-connector"]);
  expect(owner["agents"]).toBeDefined();
  expect(owner["runtime"]).toBeDefined();
  expect([...readServableEvents(fixture.db, Object.values(fixture.events)).keys()].length).toBeGreaterThan(0);
  for (const reader of READERS) {
    await expect(serve(reader, "system_health", {})).rejects.toMatchObject({
      code: "unsupported_contract", message: "requested contract unavailable",
    });
  }
});

test("a claim the agent cannot read is refused exactly like one that does not exist", async () => {
  const { insertClaim } = await import("../../src/claims/store");
  const { claimInput } = await import("../claims/helpers");
  const stored = await insertClaim(
    { db: fixture.db },
    claimInput(fixture.events["private"] as string, {
      subject: "person:grace",
      subjects: ["person:grace"],
      predicate: "employment.works_at",
      object: "the private orchard",
      body: "Grace works at the private orchard.",
      sensitivity: "private",
    }),
  );
  if (stored.outcome !== "stored") throw new Error("fixture claim");
  const claim = getClaim(fixture.db, stored.claim.claim_id)!;
  const absent = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
  const refusal = async (reader: string, target: Record<string, unknown>) => {
    try {
      await dispatchServeTool(fixture.agent(reader), "correct", {
        statement: "It is something else.",
        target,
        dry_run: true,
      }, { response_contract: "kizuki.envelope/v2" });
    } catch (error) {
      const { code, message } = error as { code: string; message: string };
      return { code, message };
    }
    throw new Error("expected a refusal");
  };
  for (const [hidden, missing] of [
    [{ claim_id: claim.claim_id }, { claim_id: absent }],
    [{ subject: "person:grace" }, { subject: "person:nobody" }],
    [{ claim_key: claim.claim_key! }, { claim_key: "0".repeat(64) }],
  ] as const) {
    expect(await refusal("reader-personal", hidden)).toEqual(
      await refusal("reader-personal", missing),
    );
  }
  // The owner's view is unchanged: the same call resolves.
  const dry = await dispatchServeTool(fixture.owner(), "correct", {
    statement: "It is something else.",
    target: { claim_id: claim.claim_id },
    dry_run: true,
  });
  expect((dry.data as { superseded: unknown[] }).superseded).toHaveLength(1);
});

test("propose refuses an unreadable event and an absent one identically", async () => {
  const refusal = async (id: string) => {
    try {
      await dispatchServeTool(fixture.agent("reader-public"), "propose", {
        kind: "claim",
        target: "facts:oracle",
        body: "An oracle probe.",
        provenance: [id],
      }, { response_contract: "kizuki.envelope/v2" });
    } catch (error) {
      const { code, message } = error as { code: string; message: string };
      return { code, message };
    }
    throw new Error("expected a refusal");
  };
  expect(await refusal(fixture.events["private"] as string)).toEqual(
    await refusal("01ZZZZZZZZZZZZZZZZZZZZZZZZ"),
  );
});

test("a task capture the agent cannot read answers like an absent one", async () => {
  const ask = async (reader: string, id: string) => packetOf(
    await serve(reader, "context_packet", { purpose: "recall", include: [], task_event_id: id }),
  ).task;
  expect(
    await ask("reader-public", fixture.events["private"] as string),
  ).toEqual(await ask("reader-public", "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
});
