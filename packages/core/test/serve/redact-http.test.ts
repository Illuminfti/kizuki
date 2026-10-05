import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { startServeHttp } from "../../src/serve/http";
import { SECRET_FRAGMENTS } from "../helpers/synthetic-secrets";
import { redactFixture } from "../serving/redact-fixture";
import type { RedactFixture } from "../serving/redact-fixture";

setDefaultTimeout(60_000);

const OWNER_TOKEN = "owner-token-not-a-secret-fixture";
let fixture: RedactFixture;
let handle: ReturnType<typeof startServeHttp>;

beforeAll(async () => {
  fixture = await redactFixture();
  handle = startServeHttp({ db: fixture.db, vaultPath: fixture.vaultPath, host: "127.0.0.1", token: OWNER_TOKEN });
});
afterAll(async () => {
  await handle.stop();
  fixture.dispose();
});

async function post(token: string, tool: string, args: Record<string, unknown>, expectedStatus = 200): Promise<{ text: string; value: Record<string, unknown> }> {
  const response = await fetch(`${handle.url}/v1/mcp/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  expect(response.status).toBe(expectedStatus);
  const text = await response.text();
  const body = JSON.parse(text) as { value?: Record<string, unknown> };
  return { text, value: body.value ?? body };
}

const CALLS: [string, Record<string, unknown>][] = [
  ["search", { query: "kettle", scope: "all", limit: 50 }],
  ["get_page", { id: "fact:secret" }],
  ["query_entities", { type: "person", name: "secret" }],
  ["timeline", { since: "2026-02-28T10:00:00Z", until: "2026-02-28T11:00:00Z" }],
  ["context_packet", { purpose: "recall", query: "kettle", include: ["canon", "timeline", "claims"], since: "2026-02-01T00:00:00Z", until: "2026-03-30T00:00:00Z", budget_tokens: 2000, hooks: ["session_start"] }],
  ["graph_neighbors", { id: "fact:secret", kinds: ["wikilink"] }],
];

test("loopback HTTP serves an agent redacted text with counts and the owner raw text", async () => {
  for (const [tool, args] of CALLS) {
    const agent = await post(fixture.tokens["reader-private"]!, tool, args);
    for (const fragment of SECRET_FRAGMENTS) expect(agent.text).not.toContain(fragment);
    expect(agent.value["redacted"]).toBeDefined();
    const owner = await post(OWNER_TOKEN, tool, args);
    expect(owner.value).not.toHaveProperty("redacted");
  }
  const raw = await post(OWNER_TOKEN, "get_page", { id: "fact:secret" });
  expect(raw.text).toContain(SECRET_FRAGMENTS[0]!);
});

test("loopback HTTP system_health for an agent omits vault-wide state", async () => {
  const agent = (await post(fixture.tokens["reader-public"]!, "system_health", {})).value["data"] as Record<string, unknown>;
  expect(agent).not.toHaveProperty("agents");
  expect(JSON.stringify(agent)).not.toContain("hidden-connector");
  const owner = (await post(OWNER_TOKEN, "system_health", {})).value["data"] as Record<string, unknown>;
  expect(JSON.stringify(owner)).toContain("hidden-connector");
});

test("loopback HTTP refuses unknown history-tree arguments before reading capture", async () => {
  const { value } = await post(OWNER_TOKEN, "timeline", { view: "tree", conversation_id: "foreign-history" }, 400);
  const error = value["error"] as { code?: string; message?: string };
  expect(error.code).toBe("invalid_arguments");
  expect(error.message).not.toContain("foreign-history");
});

test("loopback HTTP serves a bounded tainted history node with credentials redacted", async () => {
  const { text, value } = await post(fixture.tokens["reader-private"]!, "timeline", {
    view: "tree", since: "2026-02-28T10:00:00Z", until: "2026-02-28T11:00:00Z", budget_bytes: 128,
  });
  const data = value["data"] as { view: string; node: { text: string; tainted: boolean } };
  expect(data.view).toBe("tree");
  expect(data.node.tainted).toBe(true);
  expect(new TextEncoder().encode(data.node.text).byteLength).toBeLessThanOrEqual(128);
  expect(value["quoted"]).toEqual([]);
  expect(value["redacted"]).toBeDefined();
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
});
