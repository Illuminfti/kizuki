import { expect, test } from "bun:test";
import { rebuildDerived } from "../../src/derived";
import { serveSearch } from "../../src/serving/search";
import { serveContextPacket } from "../../src/serving/packet";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";

const WINDOW = { since: "2026-01-01T00:00:00Z", until: "2026-04-01T00:00:00Z" };

test("question abstention also holds when a port nominates an unrelated live page", async () => {
  const f = await serveFixture();
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  const retrieval = new ReferenceRetrievalPort(temporary.ctx);
  retrieval.search = async () => ({
    hits: [{ doc_id: "page:person:ada", kind: "page", score: 1, snippet: "Synthetic suggestion",
      sensitivity: "public", taint: "clean", authority: "owner_authored" }],
    degraded: [], timings_ms: {}, space: null,
  });
  try {
    const query = "What is the airspeed velocity of an unladen swallow?";
    const ctx = { ...f.owner(), retrieval };
    const search = await serveSearch(ctx, { query, scope: "all" });
    const packet = await serveContextPacket(ctx, { query, include: ["canon", "timeline"], ...WINDOW });
    for (const envelope of [search, packet]) {
      expect(envelope.canon).toEqual([]);
      expect(envelope.quoted).toEqual([]);
    }
    expect(search.data?.degraded).toContain("query-no-match");
    expect(packet.data?.retrieval_degraded).toContain("query-no-match");
  } finally { await retrieval.close(); temporary.cleanup(); f.dispose(); }
}, 120_000);

function stable<T extends { at: string }>(envelope: T) {
  const { at, ...rest } = envelope;
  // These two fields advance with the call clock; every other byte, including
  // hashes and work counters, must stay identical when hidden evidence changes.
  const expires = new Date(Date.parse(at) + 15 * 60 * 1000).toISOString();
  return JSON.stringify(rest).replaceAll(at, "CALL_TIME").replaceAll(expires, "CALL_EXPIRY");
}

test("a later capture is different evidence from the version a canon page cites", async () => {
  const f = await serveFixture();
  try {
    const prior = storeEvent(f.db, "gate-revision", "2026-02-01T00:00:00Z", "The orchard gate has a blue latch.", "person:ada", "public");
    await recordedPage(f.db, f.vaultPath, "facts/gate.md", {
      id: "fact:gate", title: "Orchard gate", type: "fact", status: "active",
      sensitivity: "public", taint: "clean", sources: [prior],
    }, "The orchard gate has a blue latch.");
    const current = storeEvent(f.db, "gate-revision", "2026-02-02T00:00:00Z", "The orchard gate has a green latch.", "person:ada", "public");
    rebuildDerived(f.db, f.vaultPath);
    const search = await serveSearch(f.owner(), { query: "orchard gate", scope: "all" });
    expect(search.quoted.map(chunk => chunk.event_id)).toContain(current);
    expect(search.quoted.map(chunk => chunk.event_id)).not.toContain(prior);
    const packet = await serveContextPacket(f.owner(), { query: "orchard gate", include: ["canon", "timeline"], ...WINDOW, budget_tokens: 2000 });
    expect(packet.quoted.map(chunk => chunk.event_id)).toContain(current);
  } finally { f.dispose(); }
}, 120_000);

test("hidden literal matches cannot change question relaxation, packet bytes or counters", async () => {
  const f = await serveFixture();
  try {
    const query = "What did we decide about the launch?";
    const body = "Decision: launch remains planned.";
    const id = storeEvent(f.db, "decision", "2026-02-01T00:00:00Z", body, "person:ada", "public");
    await recordedPage(f.db, f.vaultPath, "facts/launch.md", {
      id: "fact:launch", title: "Launch decision", type: "fact", status: "active",
      sensitivity: "public", taint: "clean", sources: [id],
    }, body);
    rebuildDerived(f.db, f.vaultPath);
    const ask = () => serveSearch(f.agent("reader-public"), { query, scope: "all" });
    const packet = () => serveContextPacket(f.agent("reader-public"), { query, include: ["canon", "timeline"], ...WINDOW });
    const answerBefore = await ask();
    expect(answerBefore.canon.map(chunk => chunk.page_id)).toEqual(["fact:launch"]);
    expect(answerBefore.data?.degraded).toContain("query-relaxed");
    const contextBefore = await packet();
    expect(contextBefore.canon.map(chunk => chunk.page_id)).toEqual(["fact:launch"]);
    const before = stable(answerBefore);
    const packetBefore = stable(contextBefore);
    for (let n = 0; n < 3; n++) {
      storeEvent(f.db, `hidden-${n}`, "2026-02-01T00:00:00Z", query, "person:grace", "private");
      await recordedPage(f.db, f.vaultPath, `facts/hidden-${n}.md`, {
        id: `fact:hidden-${n}`, title: query, type: "fact", status: "active", sensitivity: "private", taint: "clean",
      }, query);
    }
    rebuildDerived(f.db, f.vaultPath);
    expect(stable(await ask())).toBe(before);
    expect(stable(await packet())).toBe(packetBefore);
  } finally { f.dispose(); }
}, 120_000);

test("hidden word frequencies cannot reorder visible keyword hits", async () => {
  const f = await serveFixture();
  try {
    storeEvent(f.db, "rank-one", "2026-02-01T00:00:00Z", "quartz quartz slate", "person:ada", "public");
    storeEvent(f.db, "rank-two", "2026-02-01T00:00:00Z", "quartz slate slate", "person:ada", "public");
    rebuildDerived(f.db, f.vaultPath);
    const ask = () => serveSearch(f.agent("reader-public"), { query: "quartz slate", scope: "ledger" });
    const answerBefore = await ask();
    expect(answerBefore.quoted).toHaveLength(2);
    const before = stable(answerBefore);
    for (let n = 0; n < 40; n++) storeEvent(f.db, `hidden-rank-${n}`, "2026-02-01T00:00:00Z", "quartz", "person:grace", "private");
    rebuildDerived(f.db, f.vaultPath);
    expect(stable(await ask())).toBe(before);
  } finally { f.dispose(); }
}, 120_000);

test("a hidden revision cannot withdraw a visible source version", async () => {
  const f = await serveFixture();
  try {
    const prior = storeEvent(f.db, "scoped-revision", "2026-02-01T00:00:00Z", "The orchard gate has a blue latch.", "person:ada", "public");
    rebuildDerived(f.db, f.vaultPath);
    const ask = () => serveSearch(f.agent("reader-public"), { query: "orchard gate", scope: "ledger" });
    const packet = () => serveContextPacket(f.agent("reader-public"), { query: "orchard gate", include: ["timeline"], ...WINDOW });
    const answerBefore = await ask();
    expect(answerBefore.quoted.map(chunk => chunk.event_id)).toEqual([prior]);
    const contextBefore = await packet();
    expect(contextBefore.quoted.map(chunk => chunk.event_id)).toEqual([prior]);
    const current = storeEvent(f.db, "scoped-revision", "2026-02-02T00:00:00Z", "The orchard gate has a green latch.", "person:ada", "private");
    rebuildDerived(f.db, f.vaultPath);
    expect(stable(await ask())).toBe(stable(answerBefore));
    expect(stable(await packet())).toBe(stable(contextBefore));
    const owner = await serveSearch(f.owner(), { query: "orchard gate", scope: "ledger" });
    expect(owner.quoted.map(chunk => chunk.event_id)).toEqual([current]);
    expect((await serveSearch(f.owner(), { query: "blue latch", scope: "ledger" })).quoted).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

test("a recency packet also folds captures into their canon page", async () => {
  const f = await serveFixture();
  try {
    const packet = await serveContextPacket(f.owner(), {
      subjects: ["person:ada"], include: ["canon", "timeline"], ...WINDOW, budget_tokens: 2000,
    });
    expect(packet.canon.length).toBeGreaterThan(0);
    expect(packet.quoted.map(chunk => chunk.event_id)).not.toContain(f.events["public"]!);
  } finally { f.dispose(); }
}, 120_000);

test("named-subject background context does not disguise an unanswerable question", async () => {
  const f = await serveFixture();
  try {
    const packet = await serveContextPacket(f.owner(), {
      query: "What is the airspeed velocity of an unladen swallow?",
      subjects: ["person:ada"], include: ["canon", "timeline"], ...WINDOW,
    });
    expect(packet.canon.length).toBeGreaterThan(0);
    expect(packet.data?.retrieval_degraded).toContain("query-no-match");
  } finally { f.dispose(); }
}, 120_000);
