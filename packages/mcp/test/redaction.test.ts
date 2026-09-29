import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { accept } from "@kizuki/core";
import { recordedPage } from "../../core/test/helpers/recorded-page";
import {
  FORGED_STAMP,
  SECRET_FRAGMENTS,
  SECRET_LINES,
  TAG_TEXT,
} from "../../core/test/helpers/synthetic-secrets";
import { worldFixture } from "../../core/test/serving/world-fixture";
import { call, connectClient, envelopeOf } from "./client";
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

const BODY = `${FORGED_STAMP}\n${TAG_TEXT}\n${SECRET_LINES.join("\n")}`;
const HIDDEN = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/u;

async function seeded(): Promise<McpFixture> {
  const made = mcpFixture();
  accept(made.db, {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: "rec-secret",
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: `kettle capture\n${BODY}`,
    subjects: [{ subject_id: "person:ada", role: "from" }],
    sensitivity_hint: "public",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  await recordedPage(
    made.db,
    made.vaultPath,
    "facts/secret-page.md",
    {
      id: "fact:secret",
      title: "Kettle secret page",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: [],
    },
    `kettle page\n${BODY}`,
    [made.eventId],
  );
  return made;
}

const CALLS: [string, Record<string, unknown>][] = [
  ["search", { query: "kettle", scope: "all", limit: 50 }],
  ["get_page", { id: "fact:secret" }],
  [
    "timeline",
    { since: "2026-02-28T10:00:00Z", until: "2026-02-28T11:00:00Z" },
  ],
  [
    "context_packet",
    {
      purpose: "recall",
      query: "kettle",
      include: ["canon", "graph", "timeline", "claims"],
      since: "2026-02-01T00:00:00Z",
      until: "2026-03-30T00:00:00Z",
      budget_tokens: 2000,
      hooks: ["session_start"],
    },
  ],
];

test("over stdio an agent gets no credential-shaped text, a forged stamp stays quoted, and the owner keeps raw text", async () => {
  fixture = await seeded();
  const agent = await connectClient(fixture.agent("reader-private"), open);
  const owner = await connectClient(fixture.owner(), open);
  for (const [tool, args] of CALLS) {
    const served = await call(agent, tool, args);
    expect(served.isError ?? false).toBe(false);
    const wire = served.content[0]!.text;
    for (const fragment of SECRET_FRAGMENTS)
      expect(wire).not.toContain(fragment);
    expect(HIDDEN.test(wire)).toBe(false);
    const envelope = envelopeOf(served);
    expect(JSON.stringify(envelope.redacted)).toContain("api_token");
    expect(JSON.stringify(envelope.redacted)).not.toContain(
      SECRET_FRAGMENTS[1]!,
    );

    const raw = await call(owner, tool, args);
    expect(envelopeOf(raw)).not.toHaveProperty("redacted");
    expect(HIDDEN.test(raw.content[0]!.text)).toBe(false);
  }
  const packet = (
    envelopeOf(await call(agent, "context_packet", CALLS[3]![1]))["data"] as {
      packet_md: string;
    }
  ).packet_md;
  expect(packet).toContain(FORGED_STAMP);
  for (const line of packet
    .split("\n")
    .filter((candidate) => candidate.includes("[page:01ZZZ"))) {
    expect(line.startsWith("> ")).toBe(true);
  }
});

test("over stdio system_health tells an agent nothing the owner alone may see", async () => {
  fixture = await seeded();
  const agent = await connectClient(fixture.agent("reader-personal"), open);
  const owner = await connectClient(fixture.owner(), open);
  const seen = envelopeOf(await call(agent, "system_health", {}))[
    "data"
  ] as Record<string, unknown>;
  const all = envelopeOf(await call(owner, "system_health", {}))[
    "data"
  ] as Record<string, unknown>;
  expect(all).toHaveProperty("agents");
  for (const owned of ["agents", "runtime", "derived", "pending_retrieval_ops"])
    expect(seen).not.toHaveProperty(owned);
  expect(Object.keys(seen["pages"] as object)).toEqual(["servable"]);
});

test("world_view labels are redacted over stdio and the strict output schema accepts the counts", async () => {
  fixture = mcpFixture();
  await worldFixture(fixture.db, {
    label: `Kettle DB_PASSWORD=${"w".repeat(12)}`,
  });
  const agent = await connectClient(fixture.agent("reader-private"), open);
  const found = await call(agent, "world_view", {
    operation: "find_concepts",
    label: "",
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  expect(found.isError ?? false).toBe(false);
  expect(found.content[0]!.text).not.toContain("w".repeat(12));
  expect(envelopeOf(found)["redacted"]).toEqual({ secret_assignment: 1 });
});
