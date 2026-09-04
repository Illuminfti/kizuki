import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCheckpoint, listConnections, openLedger } from "@kizuki/core";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);
const main = resolve(import.meta.dir, "../src/main.ts");
const token = "synthetic-local-message-token";

async function cli(env: Record<string, string | undefined>, ...args: string[]) {
  // Async child keeps the loopback fixture responsive while the real CLI runs.
  const child = Bun.spawn([process.execPath, main, ...args], {
    env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("Beeper enrollment, paginated recall, dedupe and unavailable sync preserve local custody", async () => {
  const setup = h.tempVault();
  const env = { ...setup.env, BEEPER_TOKEN: token };
  let unavailable = false;
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (unavailable) return new Response("unavailable", { status: 503 });
    if (url.pathname === "/v1/info") return Response.json({ app: "Beeper", version: "fixture" });
    if (url.pathname !== "/v1/messages/search") return new Response("not found", { status: 404 });
    const older = url.searchParams.has("cursor");
    return Response.json({ items: [{ id: older ? "second" : "first", accountID: "test-account",
      chatID: "test-chat", senderID: "test-sender", sortKey: older ? "1" : "2",
      timestamp: occurredAt, text: older ? "The orchard meeting is tomorrow." : "We agreed on the orchard launch." }],
      hasMore: !older, ...(older ? {} : { oldestCursor: "older-page" }) });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const connectArgs = ["connect", "beeper", "--token-ref", "env:BEEPER_TOKEN", "--endpoint", endpoint, "--json"];
  try {
    const connected = await cli(env, ...connectArgs);
    expect(connected.exitCode).toBe(0);
    const sourceKey = JSON.parse(connected.stdout).data.source_key as string;
    expect(JSON.parse((await cli(env, ...connectArgs)).stdout).data.source_key).toBe(sourceKey);
    const backfill = await cli(env, "backfill", "beeper");
    expect(backfill.exitCode).toBe(0);
    expect(backfill.stdout).toContain("stored=2");
    const query = await cli(env, "query", "orchard");
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain("orchard");
    const context = await cli(env, "context", "--purpose", "session", "--budget", "1200");
    expect(context.exitCode).toBe(0);
    expect(context.stdout).toContain("kizuki.beeper");
    expect(context.stdout).toContain("orchard");
    // A fresh observation of unchanged source content still deduplicates.
    const repeat = await cli(env, "backfill", "beeper");
    expect(repeat.exitCode).toBe(0);
    expect(repeat.stdout).toContain("duplicates=2");
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const before = getCheckpoint(db, "kizuki.beeper", sourceKey);
    db.close();
    unavailable = true;
    const failed = await cli(env, "sync", "beeper");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout + failed.stderr).not.toContain(token);
    const afterDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    expect(getCheckpoint(afterDb, "kizuki.beeper", sourceKey)?.cursor).toBe(before?.cursor);
    expect(listConnections(afterDb)).toHaveLength(1);
    afterDb.close();
    const saved = readdirSync(join(setup.vault, ".kizuki", "connections")).map((name) =>
      readFileSync(join(setup.vault, ".kizuki", "connections", name), "utf8")).join("\n");
    expect(saved).toContain("env:BEEPER_TOKEN");
    expect(saved).not.toContain(token);
    expect(new Set(paths)).toEqual(new Set(["/v1/info", "/v1/messages/search"]));
    // Refuse unknown active state instead of silently creating a second lineage.
    rmSync(join(setup.vault, ".kizuki", "connections", `${sourceKey}.state`));
    const missing = await cli(env, ...connectArgs);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("restore its connection state");
  } finally { await server.stop(true); }
}, 30_000);

test("rejected tokens and non-loopback endpoints cannot enroll a source", async () => {
  const setup = h.tempVault();
  const env = { ...setup.env, BEEPER_TOKEN: token };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response("denied", { status: 401 });
  } });
  try {
    const denied = await cli(env, "connect", "beeper", "--token-ref", "env:BEEPER_TOKEN", "--endpoint", `http://127.0.0.1:${server.port}`);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("unauthenticated");
    expect(denied.stderr).not.toContain(token);
    const remote = await cli(env, "connect", "beeper", "--token-ref", "env:BEEPER_TOKEN", "--endpoint", "https://example.com");
    expect(remote.exitCode).toBe(1);
    expect(remote.stderr).toContain("loopback");
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    expect(listConnections(db)).toHaveLength(0);
    db.close();
  } finally { await server.stop(true); }
}, 15_000);
