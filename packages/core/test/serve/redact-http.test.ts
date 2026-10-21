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

async function post(token: string, tool: string, args: Record<string, unknown>, status = 200): Promise<{ text: string; body: Record<string, unknown>; value: Record<string, unknown> }> {
  const response = await fetch(`${handle.url}/v1/mcp/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  expect(response.status).toBe(status);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown> & { value: Record<string, unknown> };
  return { text, body, value: body.value };
}

const CALLS: [string, Record<string, unknown>][] = [
  ["search", { query: "kettle", scope: "all", limit: 50 }],
  ["get_page", { id: "fact:secret" }],
  ["query_entities", { type: "person", name: "secret" }],
  ["timeline", { since: "2026-02-28T10:00:00Z", until: "2026-02-28T11:00:00Z" }],
  ["context_packet", { purpose: "recall", query: "kettle", include: ["canon", "timeline", "claims"], since: "2026-02-01T00:00:00Z", until: "2026-03-30T00:00:00Z", budget_tokens: 2000, hooks: ["session_start"] }],
  ["graph_neighbors", { id: "fact:secret", kinds: ["wikilink"] }],
];

test("loopback HTTP serves an agent redacted v2 text and the owner raw v1 text", async () => {
  for (const [tool, args] of CALLS) {
    const agent = await post(fixture.tokens["reader-private"]!, tool, args);
    for (const fragment of SECRET_FRAGMENTS) expect(agent.text).not.toContain(fragment);
    expect(agent.value["schema"]).toBe("kizuki.envelope/v2");
    expect(Object.keys(agent.value).sort()).toEqual(["at", "canon", "data", "principal", "quoted", "schema", "tool"]);
    if (tool === "get_page") expect(agent.text).toContain("[redacted:");
    const owner = await post(OWNER_TOKEN, tool, args);
    expect(owner.value["schema"]).toBe("kizuki.envelope/v1");
    expect(owner.value).not.toHaveProperty("redacted");
  }
  const raw = await post(OWNER_TOKEN, "get_page", { id: "fact:secret" });
  expect(raw.text).toContain(SECRET_FRAGMENTS[0]!);
});

test("loopback HTTP system_health refuses scoped clients before reporting vault-wide state", async () => {
  const agent = await post(fixture.tokens["reader-public"]!, "system_health", {}, 400);
  expect(agent.body).toEqual({ ok: false, error: {
    code: "unsupported_contract", message: "requested contract unavailable", retryable: false,
  } });
  expect(agent.text).not.toContain("hidden-connector");
  const owner = (await post(OWNER_TOKEN, "system_health", {})).value["data"] as Record<string, unknown>;
  expect(JSON.stringify(owner)).toContain("hidden-connector");
});
