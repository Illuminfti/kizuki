import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import { call, connectClient, envelopeOf, pageIds } from "./client";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

setDefaultTimeout(60_000);

let fixture: McpFixture | null = null;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  fixture?.dispose();
  fixture = null;
});

const PAGE = {
  id: "fact:late-arrival",
  title: "Late arrival",
  type: "fact",
  status: "active",
  sensitivity: "public",
  taint: "clean",
  subjects: [],
} as const;

test("a note written after a session began is read by the very next call of every canon tool", async () => {
  fixture = mcpFixture();
  const client = await connectClient(fixture.owner(), open);
  const calls = [
    ["search", { query: "harvest" }],
    ["get_page", { id: PAGE.id }],
    ["query_entities", { type: "topic" }],
    ["context_packet", { query: "harvest" }],
  ] as const;
  for (const [tool, args] of calls) {
    expect(pageIds(envelopeOf(await call(client, tool, { ...args })))).not.toContain(PAGE.id);
  }
  const health = async () =>
    (envelopeOf(await call(client, "system_health", {}))["data"] as { pages: { total: number } }).pages.total;
  const total = await health();

  await recordedPage(fixture.db, fixture.vaultPath, "facts/late-arrival.md", { ...PAGE, type: "topic" }, "The harvest note.");

  expect(await health()).toBe(total + 1);
  for (const [tool, args] of calls) {
    expect(pageIds(envelopeOf(await call(client, tool, { ...args })))).toContain(PAGE.id);
  }

  await recordedPage(fixture.db, fixture.vaultPath, "facts/late-arrival.md", { ...PAGE, type: "topic" }, "The harvest note, corrected.");
  const page = envelopeOf(await call(client, "get_page", { id: PAGE.id }))["canon"] as { excerpt: string }[];
  expect(page[0]?.excerpt.trim()).toBe("The harvest note, corrected.");
});
