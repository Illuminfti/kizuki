import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listConnections, listRunReceipts, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);
const MODEL = "synthetic/throughput-model";
const main = resolve(import.meta.dir, "../../src/main.ts");

async function cli(env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function typedCompletion(eventId: string): Response {
  const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 3 };
  const claim = {
    id: "c0",
    subject: { kind: "mention", id: "m0" },
    predicate: "employment.role",
    object: { kind: "literal", value: "orchard library collaborator" },
    body: "Ada contributes to the orchard library.",
    polarity: "positive",
    perspective: {
      holder: null,
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      anchors: [],
    },
    context: [],
    valid_from: null,
    valid_to: null,
    temporal_basis: "unknown",
    confidence: 0.7,
    sensitivity: "personal",
    anchors: [anchor],
  };
  const content = {
    schema: "kizuki.producer-response/v2",
    mentions: [{ id: "m0", label: "Ada", anchor, candidate_refs: [] }],
    claims: [claim],
  };
  return Response.json({
    id: "synthetic",
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content) },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });
}

test("owner throughput settings drive a multi-request pass through rate limits, and status shows them", async () => {
  const setup = tempVault();
  const notes = join(setup.root, "throughput-notes");
  mkdirSync(notes);
  for (const [name, text] of [
    ["a", "Ada joined the orchard library project."],
    ["b", "Ada catalogues orchard library seeds."],
    ["c", "Ada repairs orchard library shelves."],
  ] as const) {
    writeFileSync(join(notes, `${name}.md`), text);
  }
  // "limited": every request is refused. "once": only the next request is refused.
  let refuse: "none" | "once" | "limited" = "once";
  const endpoint = startFakeEndpoint((request) => {
    if (refuse === "limited" || refuse === "once") {
      if (refuse === "once") refuse = "none";
      return new Response(
        JSON.stringify({
          error: { code: 429, message: "synthetic rate limit" },
        }),
        { status: 429, headers: { "retry-after": "0" } },
      );
    }
    const prompt = (
      request.body as { messages: { content: string }[] }
    ).messages
      .map((message) => message.content)
      .join("\n");
    const eventId = /event:([0-9A-HJKMNP-TV-Z]{26})/.exec(prompt)?.[1];
    if (eventId === undefined)
      throw new Error("synthetic prompt fixture mismatch");
    return typedCompletion(eventId);
  });
  const database = join(setup.vault, ".kizuki/kizuki.db");
  const cursor = () => {
    const db = openLedger(database);
    try {
      return (
        db
          .query<{ cursor: string }, []>(
            "SELECT cursor FROM rail_cursors WHERE rail='kizuki.producer.model' AND source_key='extract'",
          )
          .get()?.cursor ?? null
      );
    } finally {
      db.close();
    }
  };
  const receipt = (stdout: string) => {
    const runId = JSON.parse(stdout).data.run_id;
    const db = openLedger(database);
    try {
      return listRunReceipts(db).find((item) => item.run_id === runId)!;
    } finally {
      db.close();
    }
  };
  try {
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", notes)
        .exitCode,
    ).toBe(1);
    const grantDb = openLedger(database);
    try {
      const source = listConnections(grantDb).find(
        (item) => item.connector_id === "kizuki.markdown-folder",
      )!;
      setSourceGrant(grantDb, {
        source_key: source.source_key,
        expected_revision: 0,
        operation_id: "fixture-throughput-grant",
        policy: {
          purposes: ["capture", "recall", "session", "derive", "extract"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked",
          egress: {
            model_endpoint: `${endpoint.base_url}/chat/completions`,
            model: MODEL,
            external_retention: "provider_managed",
          },
          sensitivity_floor: "public",
        },
      });
    } finally {
      grantDb.close();
    }
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", notes)
        .exitCode,
    ).toBe(0);
    const serveToml = join(setup.vault, ".kizuki/serve.toml");
    writeFileSync(
      serveToml,
      [
        "[serve]",
        "sync_period_s = 120",
        "[extraction]",
        "max_calls_per_pass = 3",
        "records_per_request = 1",
        "[ports.llm]",
        'id = "kizuki.llm.openai-compatible"',
        `base_url = "${endpoint.base_url}"`,
        `model = "${MODEL}"`,
        "max_retries = 2",
        "timeout_ms = 5000",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(serveToml, 0o600);

    // One refusal inside a request is retried; the pass still makes all three requests.
    const first = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(first.exitCode).toBe(0);
    expect(receipt(first.stdout)).toMatchObject({
      status: "ok",
      stopped: null,
      claims_extracted: 3,
      model: { calls: 3, unavailable: 0 },
    });
    expect(endpoint.requests).toHaveLength(4);
    const filed = cursor();
    expect(filed).not.toBeNull();

    // A provider that keeps refusing past the port's retries stops the pass cleanly.
    writeFileSync(join(notes, "d.md"), "Ada labels orchard library boxes.");
    writeFileSync(join(notes, "e.md"), "Ada waters orchard library saplings.");
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", notes)
        .exitCode,
    ).toBe(0);
    refuse = "limited";
    const limited = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(limited.exitCode).toBe(0);
    expect(receipt(limited.stdout)).toMatchObject({
      status: "stopped",
      stopped: "model:rate_limited",
      claims_extracted: 0,
      model: {
        calls: 1,
        unavailable: 1,
        diagnostic: { stage: "transport", rule: "http", http_status: 429 },
      },
    });
    expect(endpoint.requests).toHaveLength(7);
    expect(cursor()).toBe(filed);

    // The next pass resumes from the durable cursor.
    refuse = "none";
    const resumed = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(receipt(resumed.stdout)).toMatchObject({
      status: "ok",
      stopped: null,
      claims_extracted: 2,
      model: { calls: 2 },
    });
    expect(endpoint.requests).toHaveLength(9);
    expect(cursor()).not.toBe(filed);

    // Doctor and serve status report the effective settings; the period waits for a service start.
    const line =
      "throughput sync_period_s=900 max_calls_per_pass=3 records_per_request=1 max_input_tokens=8000 max_output_tokens=8192 max_pass_seconds=60 records_skipped=0 configured_sync_period_s=120 (applies at service start)";
    const doctor = await cli(setup.env, "doctor");
    expect(doctor.stdout.split("\n")).toContain(line);
    const status = await cli(setup.env, "serve", "status");
    expect(status.stdout.split("\n")).toContain(line);
    const json = await cli(setup.env, "serve", "status", "--json");
    expect(JSON.parse(json.stdout).data.doctor.throughput).toMatchObject({
      sync_period_s: 900,
      configured_sync_period_s: 120,
      max_calls_per_pass: 3,
      records_per_request: 1,
    });
  } finally {
    endpoint.stop();
  }
});
