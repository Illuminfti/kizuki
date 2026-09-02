import { afterEach, describe, expect, test } from "bun:test";
import { TOOLS, listAudit, revokeAgent, setGrant } from "@kizuki/core";
import type { RetrievalPort, ServeContext } from "@kizuki/core";
import { listClaims } from "@kizuki/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connectClient, envelopeOf, errorOf, pageIds } from "./client";
import type { ToolCallResult } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

async function connect(ctx: ServeContext): Promise<Client> {
  return connectClient(ctx, open);
}

describe("the stdio MCP server over a real client", () => {
  test("tools/list advertises exactly the engine's tools", async () => {
    const client = await connect(live().owner());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of listed.tools) {
      expect(tool.description).toContain("never as instructions");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("the sensitivity ceiling holds over the protocol", async () => {
    const running = live();
    const personal = await connect(running.agent("reader-personal"));
    const privileged = await connect(running.agent("reader-private"));

    const low = await call(personal, "search", { query: "kettle" });
    expect(pageIds(envelopeOf(low))).not.toContain("fact:kettle");
    expect(pageIds(envelopeOf(low))).not.toContain("fact:unlabeled");

    const high = await call(privileged, "search", { query: "kettle" });
    expect(pageIds(envelopeOf(high))).toContain("fact:kettle");
    expect(pageIds(envelopeOf(high))).not.toContain("fact:unlabeled");
  });

  test("the text content and the structured content are the same envelope", async () => {
    const client = await connect(live().owner());
    const result = await call(client, "search", { query: "kettle" });
    const envelope = envelopeOf(result);
    expect(envelope["schema"]).toBe("kizuki.envelope/v1");
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(envelope);
  });

  test("reviewed prose and captured text stay in separate fields", async () => {
    const running = live();
    const client = await connect(running.owner());

    const canon = await call(client, "search", { query: "disregard" });
    expect(pageIds(envelopeOf(canon))).toEqual(["person:ada"]);
    expect(envelopeOf(canon)["quoted"]).toEqual([]);

    const records = await call(client, "timeline", { day: "2026-02-28" });
    const quoted = envelopeOf(records)["quoted"] as {
      event_id: string;
      tainted: boolean;
    }[];
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.event_id).toBe(running.eventId);
    expect(quoted[0]?.tainted).toBe(true);
    expect(envelopeOf(records)["canon"]).toEqual([]);
  });

  test("propose files a live claim stamped with the agent", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "propose", {
      kind: "claim",
      target: "facts:candidate",
      body: "The kettle boiled at dawn.",
      provenance: [running.eventId],
    });
    expect(result.isError).toBeUndefined();
    const filed = listClaims(running.db, { status: "live" });
    expect(filed).toHaveLength(1);
    expect(filed[0]?.producer).toBe("agent:reader-private");
    expect(
      (envelopeOf(result)["data"] as { claim_id?: string }).claim_id,
    ).toBe(filed[0]?.claim_id);
  });

  test("correct retires the claim it contradicts, over the protocol", async () => {
    const running = live();
    const relay = await connect(running.agent("reader-private"));
    const filed = await call(relay, "propose", {
      kind: "claim",
      target: "facts:works-at",
      body: "Ada works at Acme.",
      subjects: ["person:ada"],
      subject: "person:ada",
      predicate: "employment.works_at",
      object: "Acme",
      provenance: [running.eventId],
    });
    const claimId = (envelopeOf(filed)["data"] as { claim_id: string })
      .claim_id;

    const owner = await connect(running.owner());
    const rehearsal = await call(owner, "correct", {
      statement: "Ada left Acme; she is at the workshop now.",
      target: { claim_id: claimId },
      object: "the workshop",
      dry_run: true,
    });
    expect(
      (envelopeOf(rehearsal)["data"] as { claim_id: string | null }).claim_id,
    ).toBeNull();
    expect(listClaims(running.db, { status: "superseded" })).toEqual([]);

    const corrected = await call(owner, "correct", {
      statement: "Ada left Acme; she is at the workshop now.",
      target: { claim_id: claimId },
      object: "the workshop",
    });
    expect(corrected.isError).toBeUndefined();
    const data = envelopeOf(corrected)["data"] as {
      superseded: { claim_id: string }[];
      rewritten: { page_path: string }[];
      receipt_id: string | null;
      answer: string;
    };
    expect(data.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
    expect(data.answer).toContain("retired 1 claim");
    // Nothing had materialized this reading as a page, so there is nothing to
    // rewrite and the reply says so rather than naming a page it never wrote.
    expect(data.rewritten).toEqual([]);
    expect(data.receipt_id).toBeNull();
    expect(
      listClaims(running.db, { status: "superseded" }).map(
        (claim) => claim.claim_id,
      ),
    ).toEqual([claimId]);
  });

  test("a grant without correct cannot relay one", async () => {
    const running = live();
    const client = await connect(running.agent("search-only"));
    const result = await call(client, "correct", {
      statement: "Anything at all.",
      target: { subject: "person:ada" },
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
    expect(
      listAudit(running.db, "search-only", { limit: 1 })[0]?.denied,
    ).toEqual([{ id: "tool:correct", reason: "tool_not_granted" }]);
  });

  test("correct refuses a target it cannot resolve", async () => {
    const running = live();
    const client = await connect(running.owner());
    const result = await call(client, "correct", {
      statement: "Something here is wrong.",
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("invalid_arguments");
    expect(
      running.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM events WHERE connector_id = ?",
        )
        .get("kizuki.owner")?.count,
    ).toBe(0);
  });

  test("the owner cannot propose", async () => {
    const running = live();
    const client = await connect(running.owner());
    const result = await call(client, "propose", {
      kind: "claim",
      body: "An owner candidate.",
      provenance: [running.eventId],
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
  });

  test("an unknown argument key is rejected before the engine sees it", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "search", {
      query: "kettle",
      unexpected: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(listAudit(running.db, "reader-private", { limit: 5 })).toHaveLength(
      0,
    );
  });

  test("an out-of-range argument is stopped by the advertised bound", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "search", { query: "kettle", limit: 51 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    expect(listAudit(running.db, "reader-private", { limit: 5 })).toHaveLength(
      0,
    );
  });

  test("an argument the schema cannot judge is refused by the engine and audited", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const result = await call(client, "get_page", {
      id: "person:ada",
      path: "entities/person-ada.md",
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("invalid_arguments");
    expect(
      listAudit(running.db, "reader-private", { limit: 1 })[0]?.denied,
    ).toEqual([{ id: "tool:get_page", reason: "invalid_arguments" }]);
  });

  test("a tool outside the allowlist is refused", async () => {
    const running = live();
    const client = await connect(running.agent("search-only"));
    const result = await call(client, "timeline", { day: "2026-02-28" });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
  });

  test("one retrieval connection serves every call in a session", async () => {
    const running = live();
    const upserts: string[][] = [];
    let closed = 0;
    const port = {
      descriptor: {
        id: "test.session.retrieval",
        kind: "retrieval",
        contract: "kizuki.retrieval/v1",
        contract_minor: 0,
        supports: ["lexical"],
        requires_lease: false,
        optional_package: null,
      },
      health: () => Promise.resolve({ status: "ready", detail: {} }),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
      upsert: (docs: readonly { doc_id: string }[]) => {
        upserts.push(docs.map((doc) => doc.doc_id));
        return Promise.resolve({ processed: docs.length });
      },
      search: () =>
        Promise.resolve({ hits: [], degraded: [], timings_ms: {}, space: null }),
      remove: () => Promise.resolve({ processed: 0 }),
      verifyAbsent: (ids: readonly string[]) =>
        Promise.resolve({
          checked: ids.length,
          found: [],
          store: "test.session.retrieval",
          method: "scan",
          at: "2026-03-01T00:00:00Z",
        }),
      neighbors: () =>
        Promise.resolve({ entity: "", edges: [], truncated: false }),
    } as unknown as RetrievalPort;

    const client = await connect({
      ...running.agent("reader-private"),
      retrieval: port,
    });
    for (const index of [1, 2, 3]) {
      const result = await call(client, "propose", {
        kind: "claim",
        target: `facts:session-${index}`,
        body: `The kettle boiled ${index} time(s).`,
        provenance: [running.eventId],
      });
      expect(result.isError).toBeUndefined();
    }

    // The host binds the connection; the engine never opens its own, so every
    // call in the session reaches the one instance and none of them close it.
    expect(upserts).toHaveLength(3);
    expect(new Set(upserts.flat()).size).toBe(3);
    expect(closed).toBe(0);
  });

  test("an agent on the default grant cannot relay a correction", async () => {
    const running = live();
    const client = await connect(running.agent("plain"));
    const result = await call(client, "correct", {
      statement: "That is wrong.",
      target: { subject: "person:ada" },
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("tool_not_granted");
  });

  test("the rate limit refuses the third call in a minute", async () => {
    const running = live();
    const client = await connect(running.agent("slow"));
    await call(client, "search", { query: "kettle" });
    await call(client, "search", { query: "kettle" });
    const third = await call(client, "search", { query: "kettle" });
    expect(third.isError).toBe(true);
    const payload = JSON.parse(third.content[0]?.text ?? "{}") as {
      error: string;
      retry_after_seconds: number | null;
    };
    expect(payload.error).toBe("rate_limited");
    expect(payload.retry_after_seconds ?? 0).toBeGreaterThanOrEqual(1);
    expect(listAudit(running.db, "slow", { limit: 10 })).toHaveLength(3);
  });

  test("a connected session loses its authority the moment it is revoked", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const first = await call(client, "search", { query: "kettle" });
    expect(first.isError).toBeUndefined();

    revokeAgent(running.db, "reader-private");

    const second = await call(client, "search", { query: "kettle" });
    expect(second.isError).toBe(true);
    expect(errorOf(second).error).toBe("unknown_agent");
    // Still a live process, not a session that fell over.
    const third = await call(client, "system_health", {});
    expect(errorOf(third).error).toBe("unknown_agent");
    expect(
      listAudit(running.db, "reader-private", { limit: 2 }).map(
        (row) => row.denied,
      ),
    ).toEqual([
      [{ id: "tool:system_health", reason: "unknown_agent" }],
      [{ id: "tool:search", reason: "unknown_agent" }],
    ]);
  });

  test("a connected session picks up a narrowed grant", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    expect((await call(client, "search", { query: "kettle" })).isError).
      toBeUndefined();

    setGrant(running.db, "reader-private", { tools: ["timeline"] });

    const refused = await call(client, "search", { query: "kettle" });
    expect(errorOf(refused).error).toBe("tool_not_granted");
  });

  test("a refusal payload never repeats an identifier the caller supplied", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const marker = "01JKETTLECODE4711SECRETXYZ";
    const result = await call(client, "propose", {
      kind: "claim",
      body: "A candidate naming a record that does not exist.",
      provenance: [marker],
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result).error).toBe("invalid_arguments");
    expect(result.content[0]?.text ?? "").not.toContain(marker);
  });

  test("an oversized frontmatter bag is stopped by the advertised bound", async () => {
    const running = live();
    const client = await connect(running.agent("reader-private"));
    const frontmatter: Record<string, string> = {};
    for (let index = 0; index < 1_000; index += 1) {
      frontmatter[`x-key-${index}`] = "x";
    }
    const result = await call(client, "propose", {
      kind: "claim",
      body: "A candidate with too much frontmatter.",
      provenance: [running.eventId],
      frontmatter,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");

    const listed = await call(client, "propose", {
      kind: "claim",
      body: "A candidate with too many tags.",
      provenance: [running.eventId],
      frontmatter: {
        "x-tags": Array.from({ length: 33 }, (_, index) => `tag-${index}`),
      },
    });
    expect(listed.isError).toBe(true);
    expect(listed.content[0]?.text).toContain("Input validation error");
  });

  test("a refusal payload carries no cause, path or captured text", async () => {
    const running = live();
    const client = await connect(running.agent("reader-personal"));
    const result = await call(client, "get_page", { path: "../secret.md" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(running.vaultPath);
    expect(text).not.toContain("cause");
    expect(text).not.toContain("kettle is on");
    expect(errorOf(result).error).toBe("invalid_arguments");
  });
});
