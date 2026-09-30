import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rebuildDerived } from "../../src/derived";
import { accept } from "../../src/ledger/ledger";
import { serveContextPacket } from "../../src/serving/packet";
import { serveSearch } from "../../src/serving/search";
import { validEvent } from "../fixtures";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

// Real ledger, vault and index work on a shared host.
setDefaultTimeout(60_000);

let fixture: Fixture;
const ids: Record<string, string> = {};

/** A record edited once: the ledger keeps both captures, search shows the second. */
function editedRecord(db: Fixture["db"]): { first: string; second: string } {
  const capture = (text: string): string => {
    const stored = accept(db, { ...validEvent(), source_record_id: "edited-note", text, sensitivity_hint: "public" });
    if (stored.status !== "stored") throw new Error(stored.status);
    return stored.event.event_id;
  };
  return { first: capture("The rollout owner is Marlow."), second: capture("The rollout owner is Okonkwo.") };
}

beforeAll(async () => {
  fixture = await serveFixture();
  const { db, vaultPath } = fixture;
  ids["decision"] = storeEvent(
    db, "rec-decision", "2026-01-10T09:00:00Z",
    "Decision: we will onboard two market makers before the public launch.", "person:ada", "public",
  );
  ids["origin"] = storeEvent(
    db, "rec-origin", "2026-01-11T09:00:00Z",
    "Zephyr quorum vote passed unanimously at the board meeting.", "person:ada", "public",
  );
  ids["other"] = storeEvent(
    db, "rec-other", "2026-01-12T09:00:00Z",
    "Zephyr quorum reminders go out every Friday.", "person:ada", "public",
  );
  await recordedPage(
    db, vaultPath, "facts/zephyr.md",
    {
      id: "fact:zephyr", title: "Zephyr vote", type: "fact", status: "active",
      sensitivity: "public", taint: "clean", sources: [ids["origin"] as string],
    },
    "The zephyr quorum vote passed unanimously.",
  );
  const edited = editedRecord(db);
  ids["editedFirst"] = edited.first;
  ids["editedSecond"] = edited.second;
  rebuildDerived(db, vaultPath);
});

afterAll(() => fixture.dispose());

const eventIds = (envelope: Awaited<ReturnType<typeof serveSearch>>): string[] =>
  envelope.quoted.map((chunk) => chunk.event_id).sort();

describe("question search through serving", () => {
  test("a decision question finds the decision and says the words were matched loosely", async () => {
    const envelope = await serveSearch(fixture.owner(), {
      query: "What did we decide about market makers for the launch?",
      scope: "ledger",
    });
    expect(eventIds(envelope)).toEqual([ids["decision"] as string]);
    const share = envelope.data?.coverage?.[ids["decision"] as string];
    expect(share).toBeGreaterThanOrEqual(0.6);
    expect(share).toBeLessThanOrEqual(1);
    // The shared fixture keeps unlabeled notes, so its index reports itself degraded.
    expect(envelope.data?.degraded).toContain("query-relaxed");
  });

  test("an unanswerable question serves nothing and says there was no match", async () => {
    const envelope = await serveSearch(fixture.owner(), {
      query: "What is the airspeed velocity of an unladen swallow?",
      scope: "all",
    });
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);
    expect(envelope.data?.degraded).toContain("query-no-match");
  });
});

describe("one result per real record", () => {
  test("a canon page and the capture it cites are not both returned", async () => {
    const envelope = await serveSearch(fixture.owner(), { query: "zephyr quorum", scope: "all" });
    expect(envelope.canon.map((chunk) => chunk.page_id)).toContain("fact:zephyr");
    // The cited capture is folded into its page; a different capture still answers.
    expect(eventIds(envelope)).toEqual([ids["other"] as string]);
  });

  test("a superseded version is not searchable as current", async () => {
    const old = await serveSearch(fixture.owner(), { query: "Marlow", scope: "ledger" });
    expect(eventIds(old)).toEqual([]);
    const current = await serveSearch(fixture.owner(), { query: "Okonkwo", scope: "ledger" });
    expect(eventIds(current)).toEqual([ids["editedSecond"] as string]);
  });

  test("a superseded version stays out after the index is rebuilt", async () => {
    rebuildDerived(fixture.db, fixture.vaultPath);
    const old = await serveSearch(fixture.owner(), { query: "Marlow", scope: "ledger" });
    expect(eventIds(old)).toEqual([]);
    const count = fixture.db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM search_docs WHERE doc_id LIKE 'event:%' AND body LIKE 'The rollout owner%'")
      .get()!.count;
    // Both versions remain in the shared projection; the reader-scoped query
    // chooses the current one without letting a hidden edit withdraw an answer.
    expect(count).toBe(2);
  });
});

const JANUARY = { since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z" } as const;

describe("the packet is chosen by its query", () => {
  test("a query pulls the captures that match it, not the latest ones", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      query: "market makers launch",
      include: ["timeline"],
      ...JANUARY,
    });
    expect(packet.quoted.map((chunk) => chunk.event_id)).toEqual([ids["decision"] as string]);
    expect(packet.data!.packet_md).toContain("onboard two market makers");
    expect(packet.data!.packet_md).not.toContain("Zephyr");
  });

  test("different queries give different packets", async () => {
    const a = await serveContextPacket(fixture.owner(), { query: "market makers launch", include: ["timeline"], ...JANUARY });
    const b = await serveContextPacket(fixture.owner(), { query: "zephyr reminders friday", include: ["timeline"], ...JANUARY });
    expect(b.quoted.map((chunk) => chunk.event_id)).toEqual([ids["other"] as string]);
    expect(a.data!.packet_hash).not.toBe(b.data!.packet_hash);
  });

  test("the default recency window still bounds a query, and an explicit window widens it", async () => {
    const recent = await serveContextPacket(fixture.owner(), { query: "market makers launch", include: ["timeline"] });
    expect(recent.quoted).toEqual([]);
    const widened = await serveContextPacket(fixture.owner(), {
      query: "market makers launch",
      include: ["timeline"],
      since: "2026-01-01T00:00:00Z",
      until: "2030-01-01T00:00:00Z",
    });
    expect(widened.quoted.map((chunk) => chunk.event_id)).toEqual([ids["decision"] as string]);
  });

  test("an unanswerable query yields empty sections and a no-match label", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      query: "What is the airspeed velocity of an unladen swallow?",
      include: ["canon", "timeline"],
      ...JANUARY,
    });
    expect(packet.data!.sections).toEqual({ canon: 0, graph: 0, timeline: 0, claims: 0 });
    expect(packet.data!.retrieval_degraded).toContain("query-no-match");
  });

  test("a canon page and the capture it cites are not both packed", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      query: "zephyr quorum",
      include: ["canon", "timeline"],
      ...JANUARY,
    });
    expect(packet.canon.map((chunk) => chunk.page_id)).toContain("fact:zephyr");
    expect(packet.quoted.map((chunk) => chunk.event_id)).toEqual([ids["other"] as string]);
  });

  test("named subjects scope a queried packet: the matches come first, the subject's other captures follow", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      query: "market makers launch",
      subjects: ["person:ada"],
      include: ["timeline"],
      ...JANUARY,
    });
    const order = packet.quoted.map((chunk) => chunk.event_id);
    expect(order[0]).toBe(ids["decision"] as string);
    expect(order).toContain(ids["origin"] as string);
    expect(new Set(order).size).toBe(order.length);
  });

  test("a packet without a query keeps its recency window", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      include: ["timeline"],
      since: "2026-01-10T00:00:00Z",
      until: "2026-01-11T12:00:00Z",
    });
    expect(packet.quoted.map((chunk) => chunk.event_id).sort()).toEqual(
      [ids["decision"] as string, ids["origin"] as string].sort(),
    );
  });
});

describe("bounded scan of withheld candidates", () => {
  test("a common word over hundreds of withheld captures still returns the ones it may serve, quickly", async () => {
    const live = await serveFixture();
    try {
      for (let index = 0; index < 700; index += 1) {
        storeEvent(live.db, `bulk-${index}`, "2026-02-01T00:00:00Z", `common widget report ${index}`, "person:ada", undefined);
      }
      const allowed = [0, 1, 2, 3, 4].map((index) =>
        storeEvent(live.db, `ok-${index}`, "2026-02-02T00:00:00Z", `common widget approved ${index}`, "person:ada", "public"),
      );
      rebuildDerived(live.db, live.vaultPath);
      const started = performance.now();
      const envelope = await serveSearch(live.owner(), { query: "common widget", scope: "ledger", limit: 10 });
      const elapsed = performance.now() - started;
      expect(eventIds(envelope)).toEqual([...allowed].sort());
      expect(envelope.data?.degraded).toContain("scan-bound");
      expect(elapsed).toBeLessThan(5_000);
      const agent = await serveSearch(live.agent("reader-private"), { query: "common widget", scope: "ledger", limit: 10 });
      expect(eventIds(agent)).toEqual([...allowed].sort());
      expect(agent.data?.degraded ?? []).not.toContain("scan-bound");
    } finally {
      live.dispose();
    }
  });
});
