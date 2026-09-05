import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCanonReceipts, listClaims, listConnections, listRunReceipts, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { startFakeEndpoint } from "../../llm/test/fake-endpoint";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);
const CANARY = "synthetic-private-provider-canary";
const MODEL = "deepseek/deepseek-v4-flash-0731";
const main = resolve(import.meta.dir, "../src/main.ts");

async function cli(env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], { env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("native source consent, model canon, rejected responses and doctor compose", async () => {
  const setup = tempVault();
  const notes = join(setup.root, "model-notes"); mkdirSync(notes);
  writeFileSync(join(notes, "ada.md"), "Ada joined the orchard library project.");
  let mode: "ok" | "metadata" | "claims" = "ok";
  const endpoint = startFakeEndpoint(request => {
    const prompt = (request.body as { messages: { content: string }[] }).messages[1]!.content;
    const eventId = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1];
    const subjectJson = /"subject":"((?:\\.|[^"])*)"/.exec(prompt)?.[1];
    if (eventId === undefined || subjectJson === undefined) throw new Error("synthetic prompt fixture mismatch");
    const claim = { kind: "claim", subject: JSON.parse(`"${subjectJson}"`), predicate: "employment.role", object: "orchard library collaborator",
      polarity: "positive", body: "Ada contributes to the orchard library.", valid_from: null, valid_to: null, confidence: 0.7, sensitivity: "personal", event_ids: [eventId] };
    return Response.json({ id: "synthetic", model: MODEL, provider: CANARY,
      choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop", logprobs: null,
        message: { role: "assistant", content: JSON.stringify({ claims: [mode === "claims" ? { ...claim, predicate: { [CANARY]: CANARY } } : claim] }), refusal: null,
          reasoning: CANARY, name: CANARY, [CANARY]: { data: CANARY }, ...(mode === "metadata" ? { annotations: [{ text: CANARY }] } : {}) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } });
  });
  const database = join(setup.vault, ".kizuki/kizuki.db");
  try {
    // Public import enrolls but cannot capture before the explicit fixture grant.
    const ungranted = runCli(setup.env, "import", "markdown-folder", "--source", notes);
    expect(ungranted.exitCode).toBe(1);
    const grantDb = openLedger(database);
    try {
      const source = listConnections(grantDb).find(item => item.connector_id === "kizuki.markdown-folder")!;
      setSourceGrant(grantDb, { source_key: source.source_key, expected_revision: 0, operation_id: "fixture-model-compat-grant",
        policy: { purposes: ["capture", "recall", "session", "derive", "extract", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
          egress: { model_endpoint: `${endpoint.base_url}/chat/completions`, model: MODEL, external_retention: "provider_managed" }, sensitivity_floor: "public" } });
    } finally { grantDb.close(); }
    expect(runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode).toBe(0);
    writeFileSync(join(setup.vault, ".kizuki/serve.toml"), `[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="${endpoint.base_url}"\nmodel="${MODEL}"\nmax_retries=0\ntimeout_ms=1000\n`);
    const first = await cli(setup.env, "serve", "run", "sync", "--json");
    expect(first.exitCode).toBe(0);
    const db = openLedger(database);
    let firstCursor: string | null;
    let modelClaimIds: string[];
    try {
      const receipt = listRunReceipts(db).filter(item => item.rail === "sync").at(-1)!;
      expect(receipt.model).toMatchObject({ calls: 1, input_tokens: 12, output_tokens: 8, unavailable: 0 });
      expect(receipt.model.model_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(first.stdout).data.model).toEqual(receipt.model);
      expect(receipt.claims_extracted).toBe(1);
      expect(receipt.canon_writes).toBeGreaterThan(0);
      modelClaimIds = listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model").map(claim => claim.claim_id).sort();
      expect(modelClaimIds.length).toBeGreaterThan(0);
      expect(listCanonReceipts(db, { limit: 20 }).some(receipt => receipt.writer === "loop")).toBe(true);
      firstCursor = db.query<{ cursor: string }, []>("SELECT cursor FROM checkpoints WHERE connector_id='kizuki.producer.model' AND source_key='extract'").get()?.cursor ?? null;
    } finally { db.close(); }
    expect(endpoint.requests).toHaveLength(1);
    writeFileSync(join(notes, "new.md"), "Ada coordinates the orchard library reading group.");
    expect(runCli(setup.env, "import", "markdown-folder", "--source", notes).exitCode).toBe(0);
    for (const failureMode of ["metadata", "claims", "network"] as const) {
      if (failureMode === "network") endpoint.stop(); else mode = failureMode;
      const failedRun = await cli(setup.env, "serve", "run", "sync", "--json");
      expect(failedRun.exitCode).toBe(0);
      const failedRunId = JSON.parse(failedRun.stdout).data.run_id;
      const db = openLedger(database);
      try {
        const receipt = listRunReceipts(db).find(item => item.run_id === failedRunId)!;
        expect(receipt.claims_extracted).toBe(0);
        expect(listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model").map(claim => claim.claim_id).sort()).toEqual(modelClaimIds);
        expect(receipt.model.diagnostic?.stage).toBe(failureMode === "metadata" ? "response" : failureMode === "claims" ? "claims" : "transport");
        expect(receipt.model.unavailable).toBe(failureMode === "network" ? 1 : 0);
        expect(db.query<{ cursor: string }, []>("SELECT cursor FROM checkpoints WHERE connector_id='kizuki.producer.model' AND source_key='extract'").get()?.cursor ?? null).toBe(firstCursor);
      } finally { db.close(); }
      const doctor = await cli(setup.env, "doctor", "--json");
      const model = JSON.parse(doctor.stdout).data.serve.model;
      expect(model.last_success_at).not.toBeNull();
      expect(model.last_failure).not.toBeNull();
      expect(JSON.stringify([model, first])).not.toContain(MODEL);
      expect(JSON.stringify([first, doctor, readFileSync(join(setup.vault, ".kizuki/run-receipts.jsonl"), "utf8")])).not.toContain(CANARY);
    }
    expect(endpoint.requests).toHaveLength(3);
  } finally { endpoint.stop(); }
}, 30_000);
