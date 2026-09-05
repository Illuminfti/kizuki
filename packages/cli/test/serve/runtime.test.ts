import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCanonReceipts, listClaims, listRunReceipts, openLedger, setSourceGrant, sourcePolicyEpoch } from "@kizuki/core";
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

async function exerciseModelJourney(mode: "legacy" | "local_only" | "model") {
  const setup = tempVault();
  const env = { ...setup.env, BEEPER_TOKEN: token };
  let emit = 0;
  let modelUnavailable = false;
  let modelRequests = 0;
  const modelPaths: string[] = [];
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
      if (url.pathname.endsWith("/chat/completions")) {
        modelPaths.push(url.pathname);
      }
      if (url.pathname === "/v1/chat/completions") {
        modelRequests += 1;
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
    const enrolled = JSON.parse((await cli(env, "connect", "status", "--json")).stdout).data.connections[0];
    if (mode !== "legacy") {
      // This is a runtime composition fixture, not a policy-file custody test.
      // Grant through the trusted core seam so UID-mapped sandboxes do not
      // weaken or bypass the separate POSIX policy-file checks.
      const consent = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
      try {
        setSourceGrant(consent, {
          source_key: enrolled.source_key,
          expected_revision: 0,
          operation_id: mode === "model" ? "fixture-model-grant" : "fixture-local-grant",
          policy: {
          purposes: ["capture", "recall", "session", "derive", "extract", "export"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked",
          egress: mode === "model"
            ? { model_endpoint: `${endpoint}/v1/chat/completions`, model: "loopback", external_retention: "provider_managed" }
            : "local_only",
          sensitivity_floor: "public",
          },
        });
      } finally { consent.close(); }
    } else {
      // Historical pre-consent fixture only. Production enrollment always requires
      // consent; this row reconstructs an existing legacy connection at epoch zero.
      const historical = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
      try {
        historical.query("UPDATE connections SET consent_required=0 WHERE source_key=?").run(enrolled.source_key);
        expect(sourcePolicyEpoch(historical)).toBe(0);
      } finally { historical.close(); }
    }
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}/v1"\nmodel = "loopback"\ntimeout_ms = 1000\nmax_retries = 0\n`,
    );
    emit = 1;
    const served = await cli(env, "serve", "--once", "--no-http", "--json");
    expect(served.exitCode).toBe(0);
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const receipt = listRunReceipts(db, { limit: 20 }).find((item) => item.rail === "sync" && item.events_synced > 0);
      expect(receipt).toBeDefined();
      expect(receipt?.events_stored).toBeGreaterThan(0);
      if (mode === "local_only") {
        expect(receipt?.claims_extracted).toBe(0);
        expect(receipt?.model.calls).toBe(0);
        expect(modelRequests).toBe(0);
        expect(modelPaths).toEqual([]);
        expect(listClaims(db, { status: "live", limit: 20 }).some((claim) => claim.object === "orchard library collaborator")).toBe(false);
      } else {
      expect(receipt?.claims_extracted).toBe(1);
      expect(receipt?.canon_writes).toBeGreaterThan(0);
      expect(receipt?.model.model_ref).toBe("kizuki.llm.openai-compatible:loopback@127.0.0.1");
      expect(receipt?.model.calls).toBe(1);
      expect(receipt?.model.input_tokens).toBe(10);
      expect(receipt?.model.output_tokens).toBe(10);
      expect(receipt?.claims_rejected).toEqual({});
      expect(listClaims(db, { status: "live", limit: 20 }).some((claim) => claim.object === "orchard library collaborator")).toBe(true);
      expect(listCanonReceipts(db, { limit: 20 }).some((item) => item.writer === "loop")).toBe(true);
      expect(modelPaths).toEqual(["/v1/chat/completions"]);
      }
    } finally {
      db.close();
    }
    if (mode === "local_only") {
      const captured = await cli(env, "query", "orchard");
      expect(captured.exitCode).toBe(0);
      expect(captured.stdout).toContain("Ada joined the orchard library project");
      expect(captured.stdout).not.toContain("orchard library collaborator");
      return;
    }
    const queried = await cli(env, "query", "orchard library collaborator");
    expect(queried.exitCode).toBe(0);
    expect(queried.stdout).toContain("orchard");
    expect(queried.stdout).toContain("collaborator");
    emit = 2;
    if (mode === "model") {
      writeFileSync(
        join(setup.vault, ".kizuki", "serve.toml"),
        `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}/v1"\nmodel = "other-model"\ntimeout_ms = 1000\nmax_retries = 0\n`,
      );
      expect((await cli(env, "serve", "--once", "--no-http", "--json")).exitCode).toBe(0);
      expect(modelRequests).toBe(1);
      expect(modelPaths).toEqual(["/v1/chat/completions"]);
      writeFileSync(
        join(setup.vault, ".kizuki", "serve.toml"),
        `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}/other"\nmodel = "loopback"\ntimeout_ms = 1000\nmax_retries = 0\n`,
      );
      expect((await cli(env, "serve", "--once", "--no-http", "--json")).exitCode).toBe(0);
      expect(modelRequests).toBe(1);
      expect(modelPaths).toEqual(["/v1/chat/completions"]);
      writeFileSync(
        join(setup.vault, ".kizuki", "serve.toml"),
        `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}/v1"\nmodel = "loopback"\ntimeout_ms = 1000\nmax_retries = 0\n`,
      );
    }
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
}

test("the shipped HTTP model consumer writes searchable canon for an explicitly historical unbound epoch-zero source", () => exerciseModelJourney("legacy"), 30_000);
test("new source enrollment with a local_only grant refuses a generic loopback HTTP model", () => exerciseModelJourney("local_only"), 30_000);
test("an exact source model grant binds the shipped HTTP runtime and mismatched destinations stay offline", () => exerciseModelJourney("model"), 30_000);

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

test("offline serve keeps the host retrieval capability bound for recovery sweeps", async () => {
  const { ConnectionStateStore } = await import("@kizuki/core");
  const { createServeRuntime } = await import("../../src/serve-runtime");
  const { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } = await import("../../../core/test/contracts/reference-retrieval");
  const { temporaryPortContext } = await import("../../../core/test/contracts/fixtures");
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  const retrieval = new ReferenceRetrievalPort(temporary.ctx);
  const runtime = await createServeRuntime({ db, vaultPath: setup.vault,
    store: new ConnectionStateStore(join(setup.vault, ".kizuki")),
    env: setup.env, err: () => {}, retrieval });
  try {
    expect(runtime.hooks.model_ref).toBeNull();
    expect(runtime.hooks.producer).toBeUndefined();
    expect(runtime.hooks.claims?.retrieval).toBe(retrieval);
    await runtime.close();
    // The caller owns the shared retrieval lifetime; closing model bindings leaves it usable.
    expect((await retrieval.health()).status).toBe("ready");
  } finally { await runtime.close(); await retrieval.close(); temporary.cleanup(); db.close(); }
});
