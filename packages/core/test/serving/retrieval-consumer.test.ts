import { afterEach, expect, test } from "bun:test";
import { setGrant } from "../../src/agents";
import type {
  EntityRef,
  GraphQueryOptions,
  GraphResult,
  RetrievalPort,
  RetrievalResult,
} from "../../src/contracts/retrieval";
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";
import { serveSearch } from "../../src/serving/search";
import { serveContextPacket } from "../../src/serving/packet";
import { serveFixture, type Fixture } from "./helpers";
import type { PortDescriptor } from "../../src/contracts/ports";

let fixture: Fixture | undefined;
const cleanups: (() => void)[] = [];
afterEach(() => { fixture?.dispose(); fixture = undefined; cleanups.splice(0).forEach((fn) => fn()); });
async function live() { return fixture = await serveFixture(); }
function port(search: RetrievalPort["search"]): RetrievalPort {
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  cleanups.push(temporary.cleanup);
  const engine = new ReferenceRetrievalPort(temporary.ctx);
  engine.search = search;
  return engine;
}
const GRAPH_DESCRIPTOR = {
  ...DIRECT_RETRIEVAL_DESCRIPTOR,
  id: "test.kizuki.retrieval.graph",
  supports: ["lexical", "graph"],
} as const satisfies PortDescriptor;
function graphPort(neighbors: RetrievalPort["neighbors"]): RetrievalPort {
  const temporary = temporaryPortContext(GRAPH_DESCRIPTOR);
  cleanups.push(temporary.cleanup);
  const engine = new ReferenceRetrievalPort(temporary.ctx, GRAPH_DESCRIPTOR) as RetrievalPort;
  engine.neighbors = neighbors;
  return engine;
}
function relatedEdge(entity: EntityRef, to: string): GraphResult {
  return {
    entity: entity.entity_id,
    edges: [{
      from: entity.entity_id,
      to,
      type: "STALE_PRIVATE_CACHE_MARKER",
      weight: 1,
      provenance: ["STALE_PRIVATE_CACHE_MARKER"],
    }],
    truncated: false,
  };
}
function relatedSection(packet: string): string {
  const start = packet.indexOf("## related");
  if (start < 0) return "";
  const next = packet.indexOf("\n## ", start + 1);
  return next < 0 ? packet.slice(start) : packet.slice(start, next);
}
function result(ids: string[]): RetrievalResult {
  return {
    hits: ids.map((doc_id) => ({ doc_id, kind: doc_id.startsWith("page:") ? "page" : "event",
      score: 1, snippet: "STALE_PRIVATE_CACHE_MARKER", sensitivity: "public", taint: "clean", authority: "owner_correction" })),
    degraded: [], timings_ms: {}, space: null,
  };
}

test("search and packets consume engine nominations using current evidence and authority", async () => {
  const f = await live();
  let calls = 0;
  const retrieval = port(async () => { calls += 1; return result(["page:person:ada"]); });
  const ctx = { ...f.owner(), retrieval };
  const search = await serveSearch(ctx, { query: "ketle" });
  expect(search.canon.map((chunk) => chunk.page_id)).toEqual(["person:ada"]);
  expect(search.canon[0]?.excerpt).toContain("Ada keeps the kettle warm.");
  expect(search.canon[0]?.authority).not.toBe("owner_correction");
  const packet = await serveContextPacket(ctx, { query: "ketle", include: ["canon"], budget_tokens: 2_000 });
  expect(packet.data?.packet_md).toContain("Ada keeps the kettle warm.");
  expect(JSON.stringify([search, packet])).not.toContain("STALE_PRIVATE_CACHE_MARKER");
  expect(calls).toBe(2);
});

test("a lying or stale engine cannot disclose excluded canon or deleted evidence", async () => {
  const f = await live();
  const retrieval = port(async () => result(["page:fact:kettle", `event:${f.events["tombstoned"]}`]));
  const search = await serveSearch({ ...f.agent("reader-public"), retrieval }, { query: "nomination-only", scope: "all" });
  expect(search.canon).toEqual([]);
  expect(search.quoted).toEqual([]);
  expect(JSON.stringify(search)).not.toContain("fact:kettle");
  expect(JSON.stringify(search)).not.toContain("STALE_PRIVATE_CACHE_MARKER");
});

test("an unavailable engine leaves the deterministic offline consumer usable", async () => {
  const f = await live();
  const retrieval = port(async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); });
  const search = await serveSearch({ ...f.owner(), retrieval }, { query: "kettle" });
  expect(search.canon.some((chunk) => chunk.page_id === "person:ada")).toBe(true);
  expect(search.data?.degraded).toContain("retrieval-unavailable");
  expect(JSON.stringify(search)).not.toContain("PRIVATE_PROVIDER_ERROR");
  const packet = await serveContextPacket({ ...f.owner(), retrieval }, { query: "kettle", budget_tokens: 2_000 });
  expect(packet.data?.sections.canon).toBeGreaterThan(0);
  expect(packet.data?.retrieval_degraded).toContain("retrieval-unavailable");
});

test("a grant narrowed while retrieval is pending refuses the whole response", async () => {
  const f = await live();
  const retrieval = port(async () => {
    setGrant(f.db, "reader-private", { ceiling: "public" });
    return result(["page:fact:kettle"]);
  });
  await expect(serveSearch({ ...f.agent("reader-private"), retrieval }, { query: "kettle" }))
    .rejects.toThrow("authority changed during request");
});

test("packets consume graph engine nominations using current evidence and authority", async () => {
  const f = await live();
  const calls: { entity: EntityRef; options: GraphQueryOptions }[] = [];
  const ctx = f.owner();
  const retrieval = graphPort(async (entity, options) => {
    calls.push({ entity, options });
    return relatedEdge(entity, "org:acme");
  });
  const packet = await serveContextPacket(
    { ...ctx, retrieval },
    { query: "warm", include: ["canon", "graph"], budget_tokens: 2_000 },
  );
  expect(calls.some((call) => call.entity.entity_id === "person:ada")).toBe(true);
  expect(calls.every((call) => call.options.hops === 1 && call.options.ceiling === ctx.principal.grant.ceiling)).toBe(true);
  const related = relatedSection(packet.data?.packet_md ?? "");
  expect(related).toContain("Acme ships kettles.");
  expect(related).toContain("[page:org:acme]");
  expect(JSON.stringify(packet)).not.toContain("STALE_PRIVATE_CACHE_MARKER");
});

test("a graph engine cannot disclose private, held, or archived pages", async () => {
  const f = await live();
  const retrieval = graphPort(async (entity) => ({
    entity: entity.entity_id,
    edges: ["org:acme", "fact:kettle", "fact:held", "fact:archived"].map((to) => ({
      from: entity.entity_id,
      to,
      type: "STALE_PRIVATE_CACHE_MARKER",
      weight: 1,
      provenance: ["STALE_PRIVATE_CACHE_MARKER"],
    })),
    truncated: false,
  }));
  const packet = await serveContextPacket(
    { ...f.agent("reader-public"), retrieval },
    { query: "warm", include: ["canon", "graph"], budget_tokens: 2_000 },
  );
  const related = relatedSection(packet.data?.packet_md ?? "");
  expect(related).toContain("Acme ships kettles.");
  expect(related).not.toContain("The private kettle protocol.");
  expect(related).not.toContain("A kettle page whose only source was purged.");
  expect(related).not.toContain("A retracted kettle note.");
  expect(JSON.stringify(packet)).not.toContain("STALE_PRIVATE_CACHE_MARKER");
});

test("a grant narrowed while graph retrieval is pending refuses the whole response", async () => {
  const f = await live();
  const retrieval = graphPort(async (entity) => {
    setGrant(f.db, "reader-private", { ceiling: "public" });
    return relatedEdge(entity, "org:acme");
  });
  await expect(serveContextPacket(
    { ...f.agent("reader-private"), retrieval },
    { query: "warm", include: ["canon", "graph"], budget_tokens: 2_000 },
  )).rejects.toThrow("authority changed during request");
});

test("an unavailable or non-graph engine keeps the offline related pages", async () => {
  const f = await live();
  const lexical = port(async () => result(["page:person:ada"]));
  const offline = await serveContextPacket(
    { ...f.owner(), retrieval: lexical },
    { query: "Nowhere", include: ["canon", "graph"], budget_tokens: 2_000 },
  );
  expect(relatedSection(offline.data?.packet_md ?? "")).toContain("Grace reviews the kettle log.");
  expect(offline.data?.retrieval_degraded).toContain("retrieval-graph-unavailable");

  const retrieval = graphPort(async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); });
  const packet = await serveContextPacket(
    { ...f.owner(), retrieval },
    { query: "Nowhere", include: ["canon", "graph"], budget_tokens: 2_000 },
  );
  expect(relatedSection(packet.data?.packet_md ?? "")).toContain("Grace reviews the kettle log.");
  expect(packet.data?.retrieval_degraded).toContain("retrieval-unavailable");
  expect(JSON.stringify(packet)).not.toContain("PRIVATE_PROVIDER_ERROR");
});
