import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { addAgent, OWNER_AGENT_GRANT } from "../../src/agents";
import { rebuildDerived } from "../../src/derived";
import { rebuildGraph } from "../../src/graph/graph";
import { search } from "../../src/search/query";
import { serveGraph } from "../../src/serving/graph";
import { serveContextPacket } from "../../src/serving/packet";
import { serveSearch } from "../../src/serving/search";
import { recordedPage, serveFixture, storeEvent, type Fixture } from "./helpers";

let fixture: Fixture;
let secret: string;
let plain: string;

beforeAll(async () => {
  fixture = await serveFixture();
  secret = storeEvent(fixture.db, "selection-secret", "2026-02-28T15:00:00Z",
    "the vault password = hunter2hunter2", "person:ada", "personal");
  plain = storeEvent(fixture.db, "selection-plain", "2026-02-28T15:30:00Z",
    "a plain note", "person:ada", "personal");
  fixture.tokens["class-reader"] = addAgent(fixture.db, "class-reader", {
    ...OWNER_AGENT_GRANT,
  }).token;
  fixture.tokens["class-open"] = addAgent(fixture.db, "class-open", {
    ...OWNER_AGENT_GRANT, deny_classes: [],
  }).token;
});

afterAll(() => { setSystemTime(); fixture.dispose(); });

async function page(id: string, title: string, body: string, source = plain) {
  return recordedPage(fixture.db, fixture.vaultPath, `facts/${id}.md`, {
    id: `fact:${id}`, title, type: "fact", status: "active",
    sensitivity: "personal", taint: "clean", sources: [source],
  }, body);
}

test("class-denied topology cannot consume the depth-two edge cap or change truncation", async () => {
  await page("class-root", "Class root", "[[Readable ring]] [[Denied ring]]");
  await page("zzz-readable-ring", "Readable ring", "[[Ring end]]");
  await page("ring-end", "Ring end", "The readable end.");
  await page("aaa-denied-ring", "Denied ring", Array.from({ length: 105 },
    (_, i) => `[[hidden-target-${i}]]`).join(" "), secret);
  rebuildGraph(fixture.db, fixture.vaultPath);

  const requests = [
    { id: "fact:class-root", depth: 2 as const, kinds: ["wikilink" as const] },
    { id: "fact:class-root", depth: 2 as const },
  ];
  const withHidden = [];
  for (const args of requests) {
    const response = await serveGraph(fixture.agent("class-reader"), args);
    expect(response.data?.edges).toContainEqual({
      src: "fact:zzz-readable-ring", dst: "fact:ring-end", kind: "wikilink",
    });
    expect(response.data?.truncated).toBe(false);
    expect(JSON.stringify(response)).not.toContain("aaa-denied-ring");
    withHidden.push(response.data);
  }
  // The same topology is readable to the owner and an explicit class opt-out.
  for (const ctx of [fixture.owner(), fixture.agent("class-open")]) {
    const response = await serveGraph(ctx, requests[0]!);
    expect(response.data?.edges).toHaveLength(100);
    expect(response.data?.truncated).toBe(true);
  }

  await page("aaa-denied-ring", "Denied ring", "No outgoing links.", secret);
  rebuildGraph(fixture.db, fixture.vaultPath);
  for (const [i, args] of requests.entries()) {
    const response = await serveGraph(fixture.agent("class-reader"), args);
    expect(response.data).toEqual(withHidden[i]);
  }
}, 120_000);

test("denied ranked canon cannot starve the packet's candidate window", async () => {
  for (let i = 0; i < 20; i += 1) {
    await page(`denied-window-${i}`, "Kettlewindow", "Kettlewindow.", secret);
  }
  await page("readable-window", "Readable window",
    `Kettlewindow. ${"A longer plain description. ".repeat(50)}`);
  rebuildDerived(fixture.db, fixture.vaultPath);

  // Establish that the unscoped twenty-row window really is fully denied.
  const raw = search(fixture.db, "kettlewindow", { scope: "canon", ceiling: "private", limit: 20 });
  expect(raw).toHaveLength(20);
  expect(raw.every(hit => hit.doc_id.includes("denied-window-"))).toBe(true);
  const found = await serveSearch(fixture.agent("class-reader"), { query: "kettlewindow" });
  expect(found.canon.map(chunk => chunk.page_id)).toEqual(["fact:readable-window"]);

  const args = { query: "kettlewindow", include: ["canon" as const], budget_tokens: 2_000 };
  setSystemTime(new Date("2026-03-01T00:00:00Z"));
  const ctx = fixture.agent("class-reader");
  const packet = await serveContextPacket(ctx, args);
  expect(packet.canon.map(chunk => chunk.page_id)).toEqual(["fact:readable-window"]);
  expect(packet.data?.sections.canon).toBe(1);
  expect(JSON.stringify(packet)).not.toContain("denied-window-");

  // Remove only hidden matches from the disposable index; readable bytes and
  // packet work counters must remain identical.
  fixture.db.query("DELETE FROM search_docs WHERE doc_id LIKE 'page:fact:denied-window-%'").run();
  const withoutHidden = await serveContextPacket(ctx, args);
  expect(withoutHidden.canon).toEqual(packet.canon);
  expect(withoutHidden.data).toEqual(packet.data);
}, 120_000);
