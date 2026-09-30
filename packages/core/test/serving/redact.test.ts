import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { getClaim } from "../../src/claims/store";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { packetTokens } from "../../src/serving/packet-tokenizer";
import { readServableEvents } from "../../src/serving/ledger";
import { bindSourceEvent, setSourceGrant, sourceCaptureAdmission } from "../../src/ledger/source-grants";
import {
  FORGED_STAMP,
  KINDS_PRESENT,
  SECRETS,
  SECRET_FRAGMENTS,
  TAG_TEXT,
} from "../helpers/synthetic-secrets";
import { redactFixture } from "./redact-fixture";
import type { RedactFixture } from "./redact-fixture";
import type { Envelope } from "../../src/serving/types";
import type { Tool } from "../../src/agents";

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
): Promise<Envelope<unknown>> {
  const ctx = reader === "owner" ? fixture.owner() : fixture.agent(reader);
  return (await dispatchServeTool(ctx, tool, args)) as Envelope<unknown>;
}

function expectClean(envelope: Envelope<unknown>): string {
  const wire = JSON.stringify(envelope);
  for (const fragment of SECRET_FRAGMENTS) expect(wire).not.toContain(fragment);
  expect(wire).toContain("[redacted:");
  expect(HIDDEN_CHARACTERS.test(wire)).toBe(false);
  return wire;
}

/** The owner's copy is raw. Previews and excerpts cut long text, so only the leading secret is asserted. */
function expectRaw(envelope: Envelope<unknown>): void {
  const wire = JSON.stringify(envelope);
  expect(wire).toContain(SECRET_FRAGMENTS[0]!);
  expect(wire).not.toContain("[redacted:");
  expect(envelope).not.toHaveProperty("redacted");
}

function expectCounts(envelope: Envelope<unknown>): void {
  for (const kind of KINDS_PRESENT)
    expect(envelope.redacted?.[kind]).toBeGreaterThan(0);
  const wire = JSON.stringify(envelope.redacted);
  for (const fragment of SECRET_FRAGMENTS) expect(wire).not.toContain(fragment);
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
    expectCounts(envelope);
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
  expectCounts(agent);
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
  // The 160-character preview may end inside a marker, so the count is the evidence here.
  for (const fragment of SECRET_FRAGMENTS) expect(JSON.stringify(list)).not.toContain(fragment);
  expect(list.redacted?.pem).toBe(1);
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

test("context_packet redacts every section, keeps its budget exact and reports counts", async () => {
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
    const data = envelope.data as {
      packet_md: string;
      tokens_estimate: number;
      budget_tokens: number;
      sections: Record<string, number>;
    };
    expect(data.sections["canon"]).toBeGreaterThan(0);
    expect(data.sections["timeline"]).toBeGreaterThan(0);
    expect(data.sections["claims"]).toBeGreaterThan(0);
    expectClean(envelope);
    expectCounts(envelope);
    expect(data.packet_md).toContain(
      `DB_PASSWORD=[redacted:secret_assignment]`,
    );
    expect(data.tokens_estimate).toBe(packetTokens(data.packet_md));
    expect(data.tokens_estimate).toBeLessThanOrEqual(data.budget_tokens);
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
  expect(envelope.redacted).toEqual({ api_token: 1 });
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

test("ids, hashes and etags are not touched, and the packet hash is that of the body served", async () => {
  const args = { purpose: "recall", query: "kettle", include: ["canon"], budget_tokens: 2000 };
  const owner = await serve("owner", "context_packet", args);
  const first = await serve("reader-private", "context_packet", args);
  const second = await serve("reader-private", "context_packet", args);
  type Packet = { packet_md: string; packet_hash: string; etag: string };
  const [ownerData, firstData, secondData] = [owner.data as Packet, first.data as Packet, second.data as Packet];
  expect(secondData.packet_hash).toBe(firstData.packet_hash);
  expect(firstData.etag).toBe(firstData.packet_hash);
  const body = (data: { packet_md: string }) => data.packet_md.split("\n").slice(3).join("\n");
  expect(new Bun.CryptoHasher("sha256").update(body(firstData)).digest("hex")).toBe(firstData.packet_hash);
  expect(firstData.packet_hash).not.toBe(ownerData.packet_hash);
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
    const packet = (envelope.data as { packet_md: string }).packet_md;
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
  const packet = (envelope.data as { packet_md: string }).packet_md;
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
  const packet = (envelope.data as { packet_md: string }).packet_md;
  expect(packet).toContain('"DB_PASSWORD=[redacted:secret_assignment]"');
  expect(packet).not.toContain("w".repeat(12));
});

test("system_health shows an agent only what it can read", async () => {
  // Connection visibility requires exact source evidence, not a connector guess.
  for (const connector of ["fixture", "hidden-connector"]) {
    const connection = fixture.db.query<{ source_key: string }, [string]>(
      "SELECT source_key FROM connections WHERE connector_id=?",
    ).get(connector);
    if (connection === null) throw new Error("missing fixture connection");
    setSourceGrant(fixture.db, {
      source_key: connection.source_key,
      expected_revision: 0,
      operation_id: `health-source-${connector}`,
      policy: {
        purposes: ["capture", "derive", "recall", "session", "correction", "export"],
        allowed_fields: ["text", "subjects", "metadata", "attachments"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: connector === "fixture" ? "public" : "private",
      },
    });
    const admission = sourceCaptureAdmission(fixture.db, connector, connection.source_key);
    if (admission === null) throw new Error("missing fixture source admission");
    for (const { event_id } of fixture.db.query<{ event_id: string }, [string]>(
      "SELECT event_id FROM events WHERE connector_id=?",
    ).all(connector)) bindSourceEvent(fixture.db, event_id, admission);
  }
  const owner = (await serve("owner", "system_health", {})).data as Record<
    string,
    any
  >;
  expect(
    owner["connections"]
      .map((row: { connector_id: string }) => row.connector_id)
      .sort(),
  ).toEqual(["fixture", "hidden-connector"]);
  expect(owner["agents"]).toBeDefined();
  expect(owner["runtime"]).toBeDefined();

  const events = [
    ...readServableEvents(fixture.db, Object.values(fixture.events)).keys(),
  ].length;
  expect(events).toBeGreaterThan(0);
  const pub = (await serve("reader-public", "system_health", {}))
    .data as Record<string, any>;
  const priv = (await serve("reader-private", "system_health", {}))
    .data as Record<string, any>;
  expect(pub["connections"]).toEqual([
    { connector_id: "fixture", source_key: fixture.sourceKey },
  ]);
  expect(
    priv["connections"]
      .map((row: { connector_id: string }) => row.connector_id)
      .sort(),
  ).toEqual(["fixture", "hidden-connector"]);
  expect(pub["events"]).toBeLessThan(priv["events"]);
  expect(priv["events"]).toBeLessThan(owner["events"] + 1);
  for (const view of [pub, priv]) {
    for (const hidden of [
      "agents",
      "runtime",
      "derived",
      "pending_retrieval_ops",
    ])
      expect(view).not.toHaveProperty(hidden);
    expect(Object.keys(view["pages"])).toEqual(["servable"]);
  }
  const wire = JSON.stringify(pub);
  expect(wire).not.toContain("hidden-connector");
  expect(wire).not.toContain(fixture.hiddenEvent);
  // The public reader's live claim count is the claims it may read, not the vault's.
  expect(pub["live_claims"]).toBeLessThanOrEqual(owner["live_claims"]);
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
      });
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
      });
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
  const ask = async (reader: string, id: string) =>
    (
      (
        await serve(reader, "context_packet", {
          purpose: "recall",
          include: [],
          task_event_id: id,
        })
      ).data as { task: unknown }
    ).task;
  expect(
    await ask("reader-public", fixture.events["private"] as string),
  ).toEqual(await ask("reader-public", "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
});
