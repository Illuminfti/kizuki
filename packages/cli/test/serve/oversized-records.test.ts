import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listConnections, listRunReceipts, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { startFakeEndpoint } from "../../../llm/test/fake-endpoint";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(90_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);
const MODEL = "synthetic/oversized-model";
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

/** One claim anchored on the first three characters of whatever text the request quoted. */
function typedCompletion(eventId: string): Response {
  const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 3 };
  const content = {
    schema: "kizuki.producer-response/v2",
    mentions: [{ id: "m0", label: "Ada", anchor, candidate_refs: [] }],
    claims: [{
      id: "c0",
      subject: { kind: "mention", id: "m0" },
      predicate: "employment.role",
      object: { kind: "literal", value: "orchard library collaborator" },
      body: "Ada contributes to the orchard library.",
      polarity: "positive",
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [],
      valid_from: null,
      valid_to: null,
      temporal_basis: "unknown",
      confidence: 0.7,
      sensitivity: "personal",
      anchors: [anchor],
    }],
  };
  return Response.json({
    id: "synthetic",
    model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });
}

function paragraphs(chars: number): string {
  let text = "";
  for (let index = 0; text.length < chars; index++) {
    text += `${index === 0 ? "" : "\n\n"}Ada notes orchard paragraph ${index}.${" The orchard library keeps calm records.".repeat(12)}`;
  }
  return text.slice(0, chars);
}

test("an oversized note is extracted in segments, an unsplittable one is skipped, and doctor names the retry", async () => {
  const setup = tempVault();
  const notes = join(setup.root, "oversized-notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "a.md"), "Ada joined the orchard library project.");
  writeFileSync(join(notes, "b.md"), paragraphs(60_000));
  writeFileSync(join(notes, "c.md"), "k".repeat(30_000));
  const endpoint = startFakeEndpoint((request) => {
    const prompt = (request.body as { messages: { content: string }[] }).messages.map((message) => message.content).join("\n");
    const eventId = /event:([0-9A-HJKMNP-TV-Z]{26})/.exec(prompt)?.[1];
    if (eventId === undefined) throw new Error("synthetic prompt fixture mismatch");
    return typedCompletion(eventId);
  });
  const database = join(setup.vault, ".kizuki/kizuki.db");
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
    expect(runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode).toBe(1);
    const grantDb = openLedger(database);
    try {
      const source = listConnections(grantDb).find((item) => item.connector_id === "kizuki.markdown-folder")!;
      setSourceGrant(grantDb, {
        source_key: source.source_key,
        expected_revision: 0,
        operation_id: "fixture-oversized-grant",
        policy: {
          purposes: ["capture", "recall", "session", "derive", "extract"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked",
          egress: { model_endpoint: `${endpoint.base_url}/chat/completions`, model: MODEL, external_retention: "provider_managed" },
          sensitivity_floor: "public",
        },
      });
    } finally {
      grantDb.close();
    }
    expect(runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode).toBe(0);
    const serveToml = join(setup.vault, ".kizuki/serve.toml");
    writeFileSync(serveToml, [
      "[extraction]",
      "max_calls_per_pass = 12",
      "records_per_request = 4",
      "max_input_tokens = 16000",
      "max_output_tokens = 16384",
      "[ports.llm]",
      'id = "kizuki.llm.openai-compatible"',
      `base_url = "${endpoint.base_url}"`,
      `model = "${MODEL}"`,
      "timeout_ms = 5000",
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(serveToml, 0o600);

    const first = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(first.exitCode).toBe(0);
    expect(receipt(first.stdout)).toMatchObject({
      status: "ok",
      stopped: null,
      errors: [],
      claims_extracted: 4,
      model: { calls: 4 },
      oversized: { segments: 3, skipped: 1 },
    });
    expect(endpoint.requests).toHaveLength(4);

    const skippedLine = "oversized records segmenting=0 skipped=1 retry: kizuki serve retry-skipped";
    expect((await cli(setup.env, "doctor")).stdout.split("\n")).toContain(skippedLine);
    expect((await cli(setup.env, "serve", "status")).stdout.split("\n")).toContain(skippedLine);
    const status = await cli(setup.env, "serve", "status", "--json");
    expect(JSON.parse(status.stdout).data.doctor.oversized).toEqual({
      segmenting: 0, skipped: 1, retry: "kizuki serve retry-skipped", detail: skippedLine,
    });

    const retried = await cli(setup.env, "serve", "retry-skipped");
    expect(retried).toMatchObject({ exitCode: 0, stdout: "requeued=1\n", stderr: "" });
    const again = await cli(setup.env, "serve", "retry-skipped", "--json");
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout).data).toEqual({ requeued: 0 });
    expect((await cli(setup.env, "doctor")).stdout.split("\n")).toContain("oversized records segmenting=1 skipped=0");
    expect((await cli(setup.env, "serve", "retry-skipped", "extra")).exitCode).toBe(2);

    // The loop decides the re-queued record again: still no safe split, so a fresh receipt and no request.
    const second = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(receipt(second.stdout)).toMatchObject({ status: "ok", errors: [], model: { calls: 0 }, oversized: { segments: 0, skipped: 1 } });
    expect(endpoint.requests).toHaveLength(4);
    expect((await cli(setup.env, "doctor")).stdout.split("\n")).toContain(skippedLine);
  } finally {
    endpoint.stop();
  }
});
