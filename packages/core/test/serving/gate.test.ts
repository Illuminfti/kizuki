import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { listAudit, revokeAgent, setGrant, TOOLS } from "../../src/agents";
import type { AuditDenial } from "../../src/agents";
import { listClaims } from "../../src/claims/store";
import { gate } from "../../src/serving/gate";
import { servePropose } from "../../src/serving/propose";
import { serveSearch } from "../../src/serving/search";
import type { Served } from "../../src/serving/gate";
import { ServeError } from "../../src/serving/types";
import type { CanonChunk, QuotedChunk } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function emptyRun(): Served<undefined> {
  return { canon: [], quoted: [], withheld: [] };
}

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

test("a default enrolled token is refused before every serving-tool callback", () => {
  const context = fixture.agent("plain");
  let called = 0;
  for (const tool of TOOLS) {
    expect(refusal(() => gate(context, tool, {}, () => { called++; return emptyRun(); })).code).toBe("tool_not_granted");
  }
  expect(called).toBe(0);
  const rows = listAudit(fixture.db, "plain", { kind: "access", limit: TOOLS.length });
  expect(rows).toHaveLength(TOOLS.length);
  expect(rows.every(row => row.denied.some(item => item.reason === "tool_not_granted"))).toBe(true);
});

const CANON: CanonChunk = {
  page_id: "person:ada",
  path: "entities/person-ada.md",
  title: "Ada",
  type: "person",
  sensitivity: "public",
  taint: "clean",
  authority: null,
  subjects: ["person:ada"],
  sources: [],
  excerpt: "Ada keeps the kettle warm.",
  truncated: false,
};

const QUOTED: QuotedChunk = {
  event_id: "01J000000000000000000EVENT",
  connector_id: "fixture",
  kind: "message",
  occurred_at: "2026-02-28T10:00:00Z",
  sensitivity: "personal",
  subjects: ["person:ada"],
  text: "the public kettle is on",
  tainted: true,
};

describe("the serving gate", () => {
  test("a tool outside the allowlist is refused and audited", () => {
    const ctx = fixture.agent("search-only");
    const error = refusal(() => gate(ctx, "timeline", {}, emptyRun));
    expect(error.code).toBe("tool_not_granted");
    expect(error.message).toBe("tool not granted");
    const rows = listAudit(fixture.db, "search-only", { limit: 1 });
    expect(rows[0]?.tool).toBe("timeline");
    expect(rows[0]?.denied).toEqual([
      { id: "tool:timeline", reason: "tool_not_granted" },
    ]);
    expect(rows[0]?.served).toEqual([]);
  });

  test("a refused call is still audited, so a flood still counts as a flood", () => {
    const ctx = fixture.agent("slow");
    gate(ctx, "search", { query: "kettle" }, emptyRun);
    gate(ctx, "search", { query: "kettle" }, emptyRun);
    const error = refusal(() =>
      gate(ctx, "search", { query: "kettle" }, emptyRun),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retry_after_seconds).not.toBeNull();
    expect(error.retry_after_seconds ?? 0).toBeGreaterThanOrEqual(1);
    const rows = listAudit(fixture.db, "slow", { limit: 1 });
    expect(rows[0]?.denied).toEqual([
      { id: "tool:search", reason: "rate_limited" },
    ]);
  });

  test("the owner is not rate limited", () => {
    const ctx = fixture.owner();
    for (let call = 0; call < 5; call += 1) {
      expect(gate(ctx, "search", { query: "kettle" }, emptyRun).principal).toBe(
        "owner",
      );
    }
  });

  test("a validator refusal inside run is audited with its own reason", () => {
    const ctx = fixture.agent("reader-public");
    const error = refusal(() =>
      gate(ctx, "get_page", { id: "person:ada" }, (): Served<undefined> => {
        throw new ServeError("invalid_arguments", "invalid arguments: id: bad");
      }),
    );
    expect(error.code).toBe("invalid_arguments");
    const rows = listAudit(fixture.db, "reader-public", { limit: 1 });
    expect(rows[0]?.denied).toEqual([
      { id: "tool:get_page", reason: "invalid_arguments" },
    ]);
  });

  test("a RangeError from the query layer becomes invalid_arguments", () => {
    const ctx = fixture.agent("reader-public");
    const error = refusal(() =>
      gate(ctx, "timeline", {}, (): Served<undefined> => {
        throw new RangeError("timeline day must be YYYY-MM-DD");
      }),
    );
    expect(error.code).toBe("invalid_arguments");
    expect(error.message).toContain("invalid arguments");
  });

  test("any other failure is generic outside core and detailed inside it", () => {
    const ctx = fixture.agent("reader-public");
    const cause = new Error("the vault page could not be read at /tmp/secret");
    const error = refusal(() =>
      gate(ctx, "search", { query: "kettle" }, (): Served<undefined> => {
        throw cause;
      }),
    );
    expect(error.code).toBe("error");
    expect(error.message).toBe("serving failed");
    expect(error.cause).toBe(cause);
    const rows = listAudit(fixture.db, "reader-public", { limit: 1 });
    expect(rows[0]?.denied).toEqual([{ id: "tool:search", reason: "error" }]);
  });

  test("the audit row hashes the free text and mirrors what was served", () => {
    const ctx = fixture.agent("reader-private");
    const envelope = gate(
      ctx,
      "search",
      { query: "kettle protocol", limit: 20 },
      (): Served<undefined> => ({
        canon: [CANON],
        quoted: [QUOTED],
        withheld: [],
      }),
    );
    expect(envelope.schema).toBe("kizuki.envelope/v1");
    expect(envelope.tool).toBe("search");
    expect(envelope.principal).toBe("reader-private");
    expect(envelope.canon).toEqual([CANON]);
    expect(envelope.quoted).toEqual([QUOTED]);
    expect(envelope.denied).toEqual([]);
    expect("data" in envelope).toBe(false);

    const row = listAudit(fixture.db, "reader-private", { limit: 1 })[0];
    expect(row?.at).toBe(envelope.at);
    expect(JSON.stringify(row?.query_shape)).not.toContain("kettle protocol");
    const shape = row?.query_shape["query"] as { sha256?: string };
    expect(shape.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.query_shape["limit"]).toBe(20);
    expect(row?.served).toEqual([
      {
        id: new Bun.CryptoHasher("sha256").update("person:ada").digest("hex"),
        sensitivity: "public",
        taint: "clean",
        authority: null,
        provenance_count: 0,
      },
      {
        id: new Bun.CryptoHasher("sha256").update(QUOTED.event_id).digest("hex"),
        sensitivity: "personal",
        taint: "quoted",
        authority: null,
        provenance_count: 1,
      },
    ]);
  });

  test("extra audit ids are merged into the audited arguments", () => {
    const ctx = fixture.agent("reader-private");
    gate(
      ctx,
      "propose",
      { body: "a candidate" },
      (): Served<{ outcome: string }> => ({
        canon: [],
        quoted: [],
        withheld: [],
        data: { outcome: "stored" },
        audit_ids: { proposal_ids: ["01J00000000000000000000PRO"] },
      }),
    );
    const row = listAudit(fixture.db, "reader-private", { limit: 1 })[0];
    const proposalId = "01J00000000000000000000PRO";
    expect(row?.query_shape["proposal_ids"]).toEqual([
      {
        len: proposalId.length,
        sha256: new Bun.CryptoHasher("sha256").update(proposalId).digest("hex"),
      },
    ]);
  });

  test("a long withheld list is bounded in the audit but exact in the envelope", () => {
    const ctx = fixture.agent("reader-private");
    const withheld: AuditDenial[] = [];
    for (let index = 0; index < 250; index += 1) {
      withheld.push({
        id: `page-${index}`,
        reason: index % 2 === 0 ? "above_ceiling" : "missing_sensitivity",
      });
    }
    const envelope = gate(
      ctx,
      "search",
      { query: "kettle" },
      (): Served<undefined> => ({ canon: [], quoted: [], withheld }),
    );
    expect(envelope.denied).toEqual([
      { reason: "above_ceiling", count: 125 },
      { reason: "missing_sensitivity", count: 125 },
    ]);

    const row = listAudit(fixture.db, "reader-private", { limit: 1 })[0];
    const audited = row?.denied ?? [];
    expect(audited).toHaveLength(202);
    expect(audited.slice(200)).toEqual([
      { id: "more:25", reason: "above_ceiling" },
      { id: "more:25", reason: "missing_sensitivity" },
    ]);
  });
});

describe("authority is re-read on every served call", () => {
  let live: Fixture;

  beforeEach(() => {
    live = serveFixture();
  });

  afterEach(() => {
    live.dispose();
  });

  test("a session started before revocation is refused on its next call", () => {
    const ctx = live.agent("reader-private");
    expect(gate(ctx, "search", { query: "kettle" }, emptyRun).canon).toEqual(
      [],
    );

    revokeAgent(live.db, "reader-private");

    const error = refusal(() =>
      gate(ctx, "search", { query: "kettle" }, emptyRun),
    );
    expect(error.code).toBe("unknown_agent");
    const row = listAudit(live.db, "reader-private", { limit: 1 })[0];
    expect(row?.denied).toEqual([
      { id: "tool:search", reason: "unknown_agent" },
    ]);
  });

  test("a revoked session is metered like any other", () => {
    const ctx = live.agent("slow");
    revokeAgent(live.db, "slow");

    expect(refusal(() => gate(ctx, "search", {}, emptyRun)).code).toBe(
      "unknown_agent",
    );
    expect(refusal(() => gate(ctx, "search", {}, emptyRun)).code).toBe(
      "unknown_agent",
    );
    // The limit that applied a moment ago still applies: a dead identity is
    // the last one that should get an unmetered path to the audit table.
    const third = refusal(() => gate(ctx, "search", {}, emptyRun));
    expect(third.code).toBe("rate_limited");
    expect(third.retry_after_seconds ?? 0).toBeGreaterThanOrEqual(1);
    expect(
      listAudit(live.db, "slow", { limit: 1 })[0]?.denied,
    ).toEqual([{ id: "tool:search", reason: "rate_limited" }]);
  });

  test("concurrent write calls are metered, not counted after the fact", async () => {
    const ctx = live.agent("slow");
    const calls = Array.from({ length: 8 }, (_, index) =>
      servePropose(ctx, {
        kind: "claim",
        target: `facts:burst-${index}`,
        body: `A concurrent kettle candidate ${index}.`,
        subjects: ["person:ada"],
        provenance: [live.events["public"] as string],
      }).then(
        () => "ok" as const,
        (error: unknown) =>
          error instanceof ServeError ? error.code : "unexpected",
      ),
    );
    const outcomes = await Promise.all(calls);

    // The claim store is awaited inside the call, so a limit checked before
    // the work and recorded after it would let all eight through.
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(2);
    expect(
      outcomes.filter((outcome) => outcome === "rate_limited"),
    ).toHaveLength(6);
    expect(
      listClaims(live.db, { status: "live" }).filter((claim) =>
        claim.body.startsWith("A concurrent kettle candidate"),
      ),
    ).toHaveLength(2);
  });

  test("a tool-not-granted flood is still metered", () => {
    const ctx = live.agent("slow");
    setGrant(live.db, "slow", { tools: ["search"] });

    expect(refusal(() => gate(ctx, "timeline", {}, emptyRun)).code).toBe(
      "tool_not_granted",
    );
    expect(refusal(() => gate(ctx, "timeline", {}, emptyRun)).code).toBe(
      "tool_not_granted",
    );
    const third = refusal(() => gate(ctx, "timeline", {}, emptyRun));
    expect(third.code).toBe("rate_limited");
    expect(
      listAudit(live.db, "slow", { limit: 1 })[0]?.denied,
    ).toEqual([{ id: "tool:timeline", reason: "rate_limited" }]);
  });

  test("a grant narrowed mid-session applies to the next call", () => {
    const ctx = live.agent("reader-private");
    expect(gate(ctx, "search", { query: "kettle" }, emptyRun).tool).toBe(
      "search",
    );

    setGrant(live.db, "reader-private", { tools: ["timeline"] });

    expect(
      refusal(() => gate(ctx, "search", { query: "kettle" }, emptyRun)).code,
    ).toBe("tool_not_granted");
  });

  test("a ceiling narrowed mid-session narrows what the same context reads", async () => {
    const ctx = live.agent("reader-private");
    const ids = async (): Promise<string[]> =>
      (await serveSearch(ctx, { query: "kettle" })).canon.map((chunk) => chunk.page_id);
    expect((await ids())).toContain("fact:kettle");

    setGrant(live.db, "reader-private", { ceiling: "public" });

    expect((await ids())).not.toContain("fact:kettle");
  });

  test("a refused call cannot grow its audit row without bound", () => {
    const ctx = live.agent("search-only");
    const frontmatter: Record<string, string> = {};
    for (let index = 0; index < 1_000; index += 1) {
      frontmatter[`key-${index}`] = "x";
    }
    expect(
      refusal(() =>
        gate(ctx, "propose", { frontmatter, provenance: [] }, emptyRun),
      ).code,
    ).toBe("tool_not_granted");

    const row = listAudit(live.db, "search-only", { limit: 1 })[0];
    const shaped = row?.query_shape["frontmatter"] as Record<string, unknown>;
    expect(Object.keys(shaped)).toHaveLength(32);
    expect(row?.query_shape["+truncated"]).toBe(968);
    expect(JSON.stringify(row?.query_shape).length).toBeLessThan(8_192);
  });

  test("the per-key caps cannot multiply into a large audit row", () => {
    const ctx = live.agent("search-only");
    const wide: Record<string, string[]> = {};
    for (let index = 0; index < 200; index += 1) {
      wide[`key-${index}`] = Array.from(
        { length: 200 },
        (_unused, entry) => `value-${index}-${entry}`,
      );
    }
    expect(
      refusal(() =>
        gate(ctx, "propose", { frontmatter: wide, provenance: [] }, emptyRun),
      ).code,
    ).toBe("tool_not_granted");

    const row = listAudit(live.db, "search-only", { limit: 1 })[0];
    expect(JSON.stringify(row?.query_shape).length).toBeLessThan(20_000);
    expect(row?.query_shape["+truncated"]).toBeGreaterThan(0);
  });

  test("root overflow preserves the exact serving marker ahead of caller keys", () => {
    const ctx = live.agent("search-only");
    const args: Record<string, unknown> = { "+truncated": 999_999 };
    for (let index = 0; index < 64; index += 1) {
      args[`field-${index}`] = Array.from({ length: 200 }, () => "private-canary");
    }
    expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
    const row = listAudit(live.db, "search-only", { limit: 1 })[0];
    expect(row?.query_shape["+truncated"]).toBeGreaterThan(0);
    expect(row?.query_shape["+truncated"]).not.toBe(999_999);
    expect(JSON.stringify(row?.query_shape)).not.toContain("private-canary");
    expect(JSON.stringify(row?.query_shape)).toContain("node_limit");
  });

  test("a caller cannot manufacture the reserved serving truncation count", () => {
    const ctx = live.agent("search-only");
    expect(refusal(() => gate(ctx, "propose", { "+truncated": 999_999 }, emptyRun)).code).toBe("tool_not_granted");
    const row = listAudit(live.db, "search-only", { limit: 1 })[0];
    expect(row?.query_shape["+truncated"]).toBe(1);
  });

  test("numeric root keys cannot displace the exact serving truncation count", () => {
    const ctx = live.agent("search-only");
    for (const count of [32, 33]) {
      const args = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), index]));
      expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
      const shape = listAudit(live.db, "search-only", { limit: 1 })[0]?.query_shape;
      expect(Object.keys(shape ?? {})).toHaveLength(32);
      expect(shape?.["+truncated"]).toBe(count === 32 ? undefined : 2);
      expect(shape?.["31"]).toBe(count === 32 ? 31 : undefined);
    }
  });

  test("nested truncation reserves space beside numeric root keys", () => {
    const ctx = live.agent("search-only");
    const args: Record<string, unknown> = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [String(index), index]));
    args["0"] = Array.from({ length: 65 }, (_, index) => index);
    expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
    const shape = listAudit(live.db, "search-only", { limit: 1 })[0]?.query_shape;
    expect(shape?.["+truncated"]).toBe(2);
    expect(shape?.["31"]).toBeUndefined();
    expect(Object.keys(shape ?? {})).toHaveLength(32);
  });

  test("the reserved field is counted once after the leaf budget is exhausted", () => {
    const ctx = live.agent("search-only");
    const args = {
      a: Array.from({ length: 64 }, (_, index) => index),
      b: Array.from({ length: 64 }, (_, index) => index),
      c: Array.from({ length: 64 }, (_, index) => index),
      "+truncated": 999_999,
    };
    expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
    expect(listAudit(live.db, "search-only", { limit: 1 })[0]?.query_shape["+truncated"]).toBe(1);
  });

  test("a prototype key remains visible as rejected evidence through the public gate", () => {
    const ctx = live.agent("search-only");
    const args = JSON.parse('{"__proto__":{"hidden":"private-canary"}}');
    expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
    const encoded = JSON.stringify(listAudit(live.db, "search-only", { limit: 1 })[0]?.query_shape);
    expect(encoded).toContain('"key":"rejected"');
    expect(encoded).toContain(new Bun.CryptoHasher("sha256").update("__proto__").digest("hex"));
    expect(encoded).not.toContain("private-canary");
  });

  test("object and array getters cannot prevent recording a refused call", () => {
    const ctx = live.agent("search-only");
    let calls = 0;
    const trap = { enumerable: true, get() { calls += 1; throw new Error("private-canary"); } };
    const values: unknown[] = [];
    Object.defineProperty(values, "0", trap);
    const args = { values };
    Object.defineProperty(args, "object_trap", trap);
    // Force a serving truncation marker as well, so copying the bounded bag
    // must preserve descriptors instead of invoking them via object spread.
    for (let index = 0; index < 40; index += 1) Object.defineProperty(args, `extra_${index}`, { value: index, enumerable: true });
    expect(refusal(() => gate(ctx, "propose", args, emptyRun)).code).toBe("tool_not_granted");
    const encoded = JSON.stringify(listAudit(live.db, "search-only", { limit: 1 })[0]?.query_shape);
    expect(calls).toBe(0);
    expect(encoded).toContain('"type":"accessor"');
    expect(encoded).not.toContain("private-canary");
  });
});
