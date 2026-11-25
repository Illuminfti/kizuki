import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { openLedger } from "../../src/ledger/db";
import { startServeHttp } from "../../src/serve/http";
import type { Database } from "bun:sqlite";
import { accept, addAgent, getClaim, OWNER_AGENT_GRANT } from "../../src/index";
import { MAX_HTTP_BODY_BYTES } from "../../src/serve/request-body";

async function withHttp(
  run: (
    post: (
      body: string | Uint8Array | null,
      tool?: string,
      token?: string,
      opts?: { method?: string; path?: string; auth?: boolean },
    ) => Promise<Response>,
    db: Database,
    vaultPath: string,
  ) => Promise<void>,
): Promise<void> {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-http-hostile-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
  const server = startServeHttp({ db, vaultPath, token: "synthetic-http-token" });
  try {
    await run((body, tool = "system_health", token = "synthetic-http-token", opts) => {
      const method = opts?.method ?? "POST";
      const path = opts?.path ?? `/v1/${tool}`;
      const headers: Record<string, string> = opts?.auth === false ? {} : { authorization: `Bearer ${token}` };
      return fetch(`${server.url}${path}`, {
        method,
        headers,
        ...(body === null ? {} : { body: typeof body === "string" ? body : new Uint8Array(body) }),
      });
    }, db, vaultPath);
  } finally {
    await server.stop();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  }
}

test("HTTP admits a schema-sized Unicode proposal body to core policy", async () => {
  await withHttp(async post => {
    const body = '{"kind":"claim","provenance":[],"body":"' + '\\u754c'.repeat(65_536) + '"}';
    const response = await post(body, "propose");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "tool_not_granted" } });
  });
});

test("HTTP stores and deduplicates raw and escaped Unicode proposals as quoted claims", async () => {
  await withHttp(async (post, db) => {
    const stored = accept(db, { schema: "kizuki.event/v1", connector_id: "synthetic", source_record_id: "unicode",
      kind: "message", occurred_at: "2026-01-15T12:00:00Z", observed_at: "2026-01-15T12:00:00Z",
      text: "synthetic evidence", subjects: [], attachments: [], metadata: {}, deleted: false, sensitivity_hint: "private" });
    if (stored.status !== "stored") throw new Error("synthetic fixture ingress failed");
    const { token } = addAgent(db, "synthetic-http-producer", OWNER_AGENT_GRANT);
    const discovery = await post(JSON.stringify({ since: "2026-01-15T00:00:00Z", until: "2026-01-16T00:00:00Z" }), "timeline", token);
    expect(discovery.status).toBe(200);
    const evidence = await discovery.json() as { value: { quoted: { eventVersion: { kind: string; token: string } }[] } };
    expect(evidence.value.quoted).toHaveLength(1);
    const body = "界".repeat(65_536);
    const raw = JSON.stringify({ kind: "claim", body, provenance: [evidence.value.quoted[0]!.eventVersion] });
    for (const [wire, outcome] of [[raw, "stored"], [raw.replace(/界/g, "\\u754c"), "duplicate"]] as const) {
      const response = await post(wire, "propose", token);
      expect(response.status).toBe(200);
      const result = await response.json() as { value: { data: { outcome: string; claim: { kind: string; token: string } } } };
      expect(result.value.data.outcome).toBe(outcome);
      expect(result.value.data.claim.kind).toBe("claim");
      const target = db.query<{ claim_id: string }, [string]>("SELECT claim_id FROM world_wire_claim_targets WHERE wire_ref=?").get(result.value.data.claim.token);
      expect(target).not.toBeNull();
      expect(getClaim(db, target!.claim_id)).toMatchObject({ body, taint: "quoted", provenance: [stored.event.event_id] });
    }
  });
});

test("HTTP rejects non-object JSON instead of executing an empty call", async () => {
  await withHttp(async (post) => {
    for (const body of ['null', '[]', 'true', '0', '"text"', '{"args":null}', '{"args":[]}', '{"args":3}']) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
    }
    expect((await post('{}')).status).toBe(200);
    expect((await post('{"args":{}}')).status).toBe(200);
  });
});

test("HTTP refuses oversized JSON before dispatch", async () => {
  await withHttp(async (post) => {
    const response = await post(JSON.stringify({ padding: "x".repeat(MAX_HTTP_BODY_BYTES) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });
});

test("HTTP refuses malformed UTF-8 instead of replacement decoding", async () => {
  await withHttp(async (post) => {
    const response = await post(Buffer.concat([Buffer.from('{"padding":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}') ]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });
});

test("HTTP bounds chunked bodies without a content-length header", async () => {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-http-chunks-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
  const server = startServeHttp({ db, vaultPath, token: "synthetic-http-token" });
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"padding":"'));
        for (let chunk = 0; chunk <= MAX_HTTP_BODY_BYTES / 4096; chunk += 1) controller.enqueue(Buffer.alloc(4096, 0x78));
        controller.enqueue(Buffer.from('"}')); controller.close();
      },
    });
    const response = await fetch(`${server.url}/v1/system_health`, {
      method: "POST", headers: { authorization: "Bearer synthetic-http-token" }, body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false });
  } finally { await server.stop(); db.close(); rmSync(vaultPath, { recursive: true, force: true }); }
});

test("HTTP refuses deep JSON but ignores structural punctuation inside strings", async () => {
  await withHttp(async post => {
    expect((await post('{"padding":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}')).status).toBe(400);
    expect((await post(JSON.stringify({ padding: '[{"brackets":"\\"}]'.repeat(100) }))).status).toBe(200);
  });
});

test("HTTP handles concurrent mixed loopback requests across owner and scoped agent cleanly", async () => {
  const { worldFixture } = await import("../serving/world-fixture");
  await withHttp(async (post, db) => {
    await worldFixture(db);
    const agent = addAgent(db, "concurrent-http-reader", { ...OWNER_AGENT_GRANT, rate_limit_per_minute: 120 });
    const responses = await Promise.all([
      post(null, undefined, undefined, { method: "GET", path: "/health", auth: false }),
      post(null, undefined, undefined, { method: "GET", path: "/v1/health", auth: false }),
      post(null, undefined, undefined, { method: "GET", path: "/v1/health" }),
      post(null, undefined, agent.token, { method: "GET", path: "/v1/health" }),
      ...Array.from({ length: 4 }, () => post("{}", "system_health")),
      ...Array.from({ length: 4 }, () => post(JSON.stringify({ query: "Bayesian" }), "search", agent.token)),
      ...Array.from({ length: 4 }, () =>
        post(
          JSON.stringify({ operation: "find_concepts", label: "Bayesian", valid: { kind: "all" }, knownAt: { kind: "current" } }),
          "world_view",
          agent.token,
        ),
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });
});

test("HTTP emits Retry-After header on 429 rate-limited and 503 busy refusals", async () => {
  const { Database } = await import("bun:sqlite");
  await withHttp(async (post, db, vaultPath) => {
    const slow = addAgent(db, "rate-limited-http-agent", { ...OWNER_AGENT_GRANT, rate_limit_per_minute: 1 });
    const first = await post(JSON.stringify({ query: "hello" }), "search", slow.token);
    expect(first.status).toBe(200);
    const limited = await post(JSON.stringify({ query: "hello" }), "search", slow.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: false } });

    const locker = new Database(join(vaultPath, ".kizuki", "kizuki.db"));
    locker.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    try {
      const busy = await post("{}", "system_health");
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("1");
      expect(await busy.json()).toMatchObject({ ok: false, error: { code: "busy", retryable: true, retry_after_seconds: 1 } });
    } finally {
      locker.close();
    }
  });
});
