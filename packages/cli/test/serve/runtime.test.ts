import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCanonReceipts, listClaims, listRunReceipts, openLedger } from "@kizuki/core";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
const main = resolve(import.meta.dir, "../../src/main.ts");
const token = "synthetic-daemon-connector-token";

afterEach(cleanup);

async function cli(env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("the shipped serve command syncs an enrolled changed source through its bound model into searchable canon", async () => {
  const setup = tempVault();
  const env = { ...setup.env, BEEPER_TOKEN: token };
  let emit = 0;
  let modelUnavailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/info") {
        return Response.json({ app: { name: "Beeper", version: "fixture" }, server: { status: "running" } });
      }
      if (url.pathname === "/v1/messages/search") {
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({
          items: emit > 0 ? [{
            id: `new-message-${emit}`, accountID: "fixture-account", chatID: "fixture-chat", senderID: "fixture-sender",
            sortKey: String(emit + 1), timestamp: `2026-09-04T10:00:0${emit}Z`, text: "Ada joined the orchard library project.",
          }] : [],
          hasMore: false,
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        if (modelUnavailable) return new Response("fixture unavailable", { status: 503 });
        const body = await request.json() as { messages: { content: string }[] };
        const prompt = body.messages[1]?.content ?? "";
        const eventId = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1];
        const subjectJson = /"subject":"((?:\\.|[^"])*)"/.exec(prompt)?.[1];
        if (eventId === undefined || subjectJson === undefined) return new Response("invalid fixture prompt", { status: 400 });
        const subject = JSON.parse(`"${subjectJson}"`) as string;
        return Response.json({
          id: "synthetic", object: "chat.completion", created: 1, model: "loopback",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ claims: [{
            kind: "claim", subject, predicate: "employment.role", object: "orchard library collaborator",
            polarity: "positive", body: "Ada is an orchard library collaborator.", valid_from: null, valid_to: null,
            confidence: 0.7, sensitivity: "personal", event_ids: [eventId],
          }] }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect((await cli(env, "connect", "beeper", "--token-ref", "env:BEEPER_TOKEN", "--endpoint", endpoint)).exitCode).toBe(0);
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}/v1"\nmodel = "loopback"\ntimeout_ms = 1000\nmax_retries = 0\n`,
    );
    emit = 1;
    const served = await cli(env, "serve", "--once", "--no-http", "--json");
    expect(served.exitCode).toBe(0);
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const receipt = listRunReceipts(db, { limit: 20 }).find((item) => item.rail === "sync");
      expect(receipt?.events_synced).toBeGreaterThan(0);
      expect(receipt?.events_stored).toBeGreaterThan(0);
      expect(receipt?.claims_extracted).toBe(1);
      expect(receipt?.canon_writes).toBeGreaterThan(0);
      expect(receipt?.model.model_ref).toBe("kizuki.llm.openai-compatible:loopback@127.0.0.1");
      expect(receipt?.model.calls).toBe(1);
      expect(receipt?.model.input_tokens).toBe(10);
      expect(receipt?.model.output_tokens).toBe(10);
      expect(receipt?.claims_rejected).toEqual({});
      expect(listClaims(db, { status: "live", limit: 20 }).some((claim) => claim.object === "orchard library collaborator")).toBe(true);
      expect(listCanonReceipts(db, { limit: 20 }).some((item) => item.writer === "loop")).toBe(true);
    } finally {
      db.close();
    }
    const queried = await cli(env, "query", "orchard library collaborator");
    expect(queried.exitCode).toBe(0);
    expect(queried.stdout).toContain("[orchard]");
    expect(queried.stdout).toContain("[collaborator]");
    emit = 2;
    modelUnavailable = true;
    expect((await cli(env, "serve", "--once", "--no-http", "--json")).exitCode).toBe(0);
    const afterUnavailable = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const receipts = listRunReceipts(afterUnavailable, { rail: "sync", limit: 20 });
      const latest = receipts.at(-1);
      expect(latest?.model.unavailable).toBe(1);
      expect(latest?.model.calls).toBe(1);
    } finally {
      afterUnavailable.close();
    }
    const doctor = await cli(env, "doctor");
    expect(doctor.stdout).toContain("unavailable=1");
  } finally {
    await server.stop(true);
  }
}, 30_000);

test("a malformed configured model fails through the public CLI without leaking its secret or writing canon", () => {
  const setup = tempVault();
  const canary = "synthetic-model-secret";
  const env = { ...setup.env, MODEL_KEY: canary };
  writeFileSync(
    join(setup.vault, ".kizuki", "serve.toml"),
    '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nmodel = "string-is-not-a-binding"\nsecret_ref = "env:MODEL_KEY"\n',
  );
  const command = runCli(env, "serve", "--once", "--no-http");
  expect(command.exitCode).toBe(1);
  expect(command.stderr).toContain("base_url is required");
  expect(command.stderr).not.toContain(canary);
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    expect(listCanonReceipts(db, { limit: 20 })).toEqual([]);
  } finally {
    db.close();
  }
});
