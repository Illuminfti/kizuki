import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXTRACTION_SYSTEM_PROMPT, addAgent,
  initAgents, listCanonReceipts, listClaims, listConnections, openLedger, readSince, setSourceGrant,
} from "../packages/core/src/index";
import type { CaptureEvent, Claim, Envelope, RunReceipt, SearchHit } from "../packages/core/src/index";
import { verifyChecksumManifest } from "./release-artifacts";
import {
  canonicalJson, corpusDigest, loadCorpus, loadResponseSet, readBoundedJson,
  scoreExtraction, sha256, validateCorpus, validateResponseSet, writeQualityReport,
} from "./evaluate-extraction";
import type { QualityCase, QualityCorpus, QualityResponse, QualityResponseSet } from "./evaluate-extraction";

const SOURCE_ROOT = resolve(import.meta.dir, "..");
const MODEL = "quality-scripted";
const ARTIFACT_NAMES = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"];
const NEGATIVE_QUERY = "zymurgylatticeabsent";

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", SOURCE_ROOT, ...args], { stdout: "pipe", stderr: "pipe" });
  assert(result.exitCode === 0, "source revision inspection failed");
  return result.stdout.toString().trim();
}

/** RFC0002 section4.2: raw null means as of the source's observed_at. */
export function persistedReference(corpus: QualityCorpus): QualityCorpus {
  const result = structuredClone(corpus);
  for (const item of result.cases) {
    for (const expected of item.expected) {
      if (expected.valid_from !== null) continue;
      const observations = new Set(expected.citation_sets.flat().map((id) => item.records.find((record) => record.id === id)!.observed_at));
      assert(observations.size === 1, "multi-observation persisted validity requires an explicit reference annotation");
      expected.valid_from = [...observations][0]!;
    }
  }
  return validateCorpus(result);
}

type ImportedEvidence = Pick<CaptureEvent, "event_id" | "source_record_id" | "text" | "subjects" | "occurred_at" | "observed_at">;

export function mapImportedEvidence(item: QualityCase, events: readonly ImportedEvidence[]): Record<string, string> {
  assert(events.length === item.records.length, "native import omitted or added evidence");
  assert(new Set(events.map((row) => row.event_id)).size === events.length && new Set(events.map((row) => row.source_record_id)).size === events.length, "native evidence IDs are not unique");
  const mapping: Record<string, string> = {};
  for (const record of item.records) {
    const event = events.find((row) => row.source_record_id === record.id);
    assert(event !== undefined && event.text === record.text && event.occurred_at === record.occurred_at && event.observed_at === record.observed_at, "native evidence differs from the frozen corpus");
    const roles = (subjects: ImportedEvidence["subjects"]) => subjects.map((subject) => `${subject.subject_id}:${subject.role}`).sort();
    assert(canonicalJson(roles(event.subjects)) === canonicalJson(roles(record.subjects)), "native import changed subject roles");
    mapping[record.id] = event.event_id;
  }
  return mapping;
}

export function verifyNativeArtifact(path: string, sourceSha: string): void {
  verifyChecksumManifest(path, ARTIFACT_NAMES);
  const build = readBoundedJson(join(path, "BUILD.json")) as { source_sha?: unknown };
  assert(build.source_sha === sourceSha, "artifact and evaluation source revisions differ");
}

interface QueryData { hits: SearchHit[]; withheld: number }
interface CommandRecord { command: string; exit_code: number; wall_ms: number; output_sha256: string; output_kind: "stdout" | "canonical_tool_results" }
interface ConsumerObservation {
  ledger_recalled: string[];
  expected_ledger: string[];
  mcp_recalled: string[];
  public_disclosures: number;
  unknown_query_hits: number;
  context_citations_complete: boolean;
  expected_canon: string[];
  canon_supported_matches: string[];
  canon: { doc_id: string; authority: string; snippet: string }[];
  failures: string[];
}
interface Replay {
  item: QualityCase;
  response: QualityResponse;
  ids: Record<string, string>;
  behavior: "normal" | "unavailable" | "malformed";
  requests: { body_sha256: string; response_sha256: string; path: string; event_ids: string[] }[];
  event_roles_present: boolean;
  errors: string[];
}

function scopedFence(prompt: string, label: string): string | null {
  assert(/^[A-Za-z0-9:_.-]+$/.test(label), "unsafe fixture fence label");
  const match = new RegExp(`<<<KZ-QUOTE ([0-9a-f]{32}) ${label}>>>\\n([\\s\\S]*?)\\n<<<KZ-END \\1>>>`).exec(prompt);
  return match?.[2] ?? null;
}

function inspectRequest(replay: Replay, raw: string): { eventIds: string[]; response: string } {
  assert(raw.length <= 100_000, "fixture request exceeds bound");
  const body = JSON.parse(raw) as { model?: unknown; messages?: { role?: unknown; content?: unknown }[]; tools?: unknown };
  assert(body.model === MODEL && body.tools === undefined && Array.isArray(body.messages) && body.messages.length === 2, "unexpected fixture model request");
  assert(body.messages[0]?.role === "system" && body.messages[0].content === EXTRACTION_SYSTEM_PROMPT && body.messages[1]?.role === "user" && typeof body.messages[1].content === "string", "native extraction prompt contract changed");
  const prompt = body.messages[1].content;
  const sentIds = [...prompt.matchAll(/<<<KZ-QUOTE [0-9a-f]{32} event:([A-Za-z0-9:_.-]+)>>>/g)].map((match) => match[1]!);
  const expectedIds = Object.values(replay.ids).sort();
  assert(canonicalJson([...sentIds].sort()) === canonicalJson(expectedIds), "native request included unauthorized or omitted evidence");
  for (const record of replay.item.records) {
    const eventId = replay.ids[record.id]!;
    assert(scopedFence(prompt, `event:${eventId}`) === record.text, "native request altered fixture evidence");
    const roles = scopedFence(prompt, `event-subjects:${eventId}`);
    if (roles === null) { replay.event_roles_present = false; continue; }
    const subjects = JSON.parse(roles) as { subject?: unknown; role?: unknown }[];
    assert(Array.isArray(subjects), "event subject metadata is malformed");
    const expected = record.subjects.map((subject) => `${subject.subject_id}:${subject.role}`).sort();
    const actual = subjects.map((subject) => `${subject.subject}:${subject.role}`).sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) replay.event_roles_present = false;
  }
  const candidate = structuredClone(replay.response.response) as { claims: { event_ids: string[] }[] };
  assert(Array.isArray(candidate.claims), "scripted response fixture is malformed");
  // Only the ledger-generated event IDs change. No candidate prose or answer
  // field is derived from the answer key or from native returned claims.
  for (const draft of candidate.claims) draft.event_ids = draft.event_ids.map((id) => {
    const mapped = replay.ids[id]; assert(mapped !== undefined, "scripted response cites unknown evidence"); return mapped;
  });
  return { eventIds: sentIds, response: JSON.stringify(candidate) };
}

function modelStatus(receipt: RunReceipt): QualityResponse["status"] {
  if (receipt.model.unavailable > 0) return "unavailable";
  if (Object.values(receipt.claims_rejected).some((count) => count > 0)) return "rejected";
  return "ok";
}

export async function runNativeQuality(options: { artifact?: string } = {}) {
  const sourceSha = git("rev-parse", "HEAD");
  const sourceTree = git("rev-parse", "HEAD^{tree}");
  assert(git("status", "--porcelain", "--", "packages").length === 0, "native evaluation requires unchanged product source");
  const corpus = loadCorpus(join(import.meta.dir, "fixtures/extraction-quality-v1.json"));
  const scripted = loadResponseSet(join(import.meta.dir, "fixtures/extraction-quality-scripted-v1.json"), corpus);
  const persisted = persistedReference(corpus);
  const root = mkdtempSync(join(tmpdir(), "kizuki-quality-native-"));
  const commands: CommandRecord[] = [];
  let executable = [process.execPath, join(SOURCE_ROOT, "packages/cli/src/main.ts")];
  let mcpExecutable = [process.execPath, join(SOURCE_ROOT, "packages/mcp/src/bin.ts")];
  let artifactDigest: string | null = null;
  let active: Replay | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const replay = active;
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions" || replay === null) return new Response("unsupported fixture route", { status: 404 });
      try {
        assert(replay.requests.length === 0, "fixture per-case model call budget exceeded");
        const raw = await request.text();
        const inspected = inspectRequest(replay, raw);
        let response: string;
        let status = 200;
        if (replay.behavior === "unavailable") { response = "synthetic unavailable"; status = 503; }
        else {
          const content = replay.behavior === "malformed" ? "not valid extraction JSON" : inspected.response;
          response = JSON.stringify({ id: "synthetic-quality", object: "chat.completion", created: 1, model: MODEL,
            ...(replay.item.id === "q12" ? { provider: "synthetic-provider" } : {}),
            choices: [{ index: 0, finish_reason: "stop", ...(replay.item.id === "q12" ? { native_finish_reason: "stop" } : {}),
              message: { role: "assistant", content, ...(replay.item.id === "q12" ? { reasoning: "Synthetic benign metadata; not an instruction." } : {}) } }] });
        }
        replay.requests.push({ body_sha256: sha256(raw), response_sha256: sha256(response), path: "/v1/chat/completions", event_ids: inspected.eventIds });
        return new Response(response, { status, headers: { "content-type": "application/json" } });
      } catch (error) {
        replay.errors.push(error instanceof Error ? error.message : "fixture request failed");
        return new Response("fixture request refused", { status: 400 });
      }
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/v1`;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KIZUKI_CONFIG: join(root, "config.toml"), KIZUKI_SUPERVISOR: "none", LANG: "C.UTF-8" };

  async function cli<T>(vault: string, args: string[], expectedExit = 0): Promise<T> {
    const start = performance.now();
    const child = Bun.spawn([...executable, ...args, "--vault", vault], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert(stdout.length <= 1_048_576 && stderr.length <= 65_536, "native command output exceeded fixture bound");
      commands.push({ command: args.slice(0, 2).join(" "), exit_code: exitCode, wall_ms: performance.now() - start, output_sha256: sha256(stdout), output_kind: "stdout" });
      assert(exitCode === expectedExit, `native ${vault.split("/").at(-2)} ${args[0]} failed (${exitCode}): ${stderr.slice(0, 300)}`);
      if (expectedExit === 1) assert(stderr.includes("consent-required"), `native import did not refuse for missing consent: ${stderr.slice(0, 300)}`);
      return (args.includes("--json") ? (JSON.parse(stdout) as { data: T }).data : stdout) as T;
    } finally { clearTimeout(timeout); }
  }

  function withLedger<T>(vault: string, fn: (db: ReturnType<typeof openLedger>) => T): T {
    const db = openLedger(join(vault, ".kizuki/kizuki.db"));
    try { return fn(db); } finally { db.close(true); }
  }

  async function mcp(vault: string, calls: { name: string; arguments: Record<string, unknown> }[], token?: string): Promise<Envelope<unknown>[]> {
    const start = performance.now();
    const child = Bun.spawn([...mcpExecutable, "--vault", vault, ...(token === undefined ? ["--owner"] : ["--token-env", "QUALITY_AGENT_TOKEN"])], {
      cwd: root, env: token === undefined ? env : { ...env, QUALITY_AGENT_TOKEN: token }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const reader = child.stdout.getReader(), decoder = new TextDecoder();
    let buffered = "", bytes = 0, nextId = 0;
    const stderr = (async () => {
      let size = 0;
      for await (const chunk of child.stderr) { size += chunk.length; if (size > 65_536) child.kill("SIGKILL"); }
      return size;
    })();
    function send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); child.stdin.flush(); }
    async function rpc(method: string, params: unknown): Promise<unknown> {
      const id = ++nextId;
      send({ jsonrpc: "2.0", id, method, params });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
          if (message.id !== id) continue;
          assert(message.error === undefined, "native MCP protocol refused fixture request");
          return message.result;
        }
        const chunk = await reader.read();
        assert(!chunk.done, "native MCP ended before returning fixture response");
        bytes += chunk.value.length;
        assert(bytes <= 1_048_576, "native MCP output exceeded fixture bound");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    }
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kizuki-synthetic-quality", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const results: Envelope<unknown>[] = [];
      for (const call of calls) {
        const result = await rpc("tools/call", call) as { isError?: boolean; structuredContent?: Envelope<unknown> };
        assert(result.isError !== true && result.structuredContent !== undefined, "native MCP tool refused fixture request");
        results.push(result.structuredContent);
      }
      child.stdin.end();
      const code = await child.exited;
      assert(code === 0 && await stderr <= 65_536, "native MCP session did not shut down cleanly");
      commands.push({ command: `mcp ${token === undefined ? "owner" : "public"} ${calls.map((call) => call.name).join(",")}`,
        exit_code: code, wall_ms: performance.now() - start, output_sha256: sha256(canonicalJson(results)), output_kind: "canonical_tool_results" });
      return results;
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await stderr;
      reader.releaseLock();
      clearTimeout(timeout);
    }
  }

  async function setup(item: QualityCase, name: string, localOnly = false) {
    const directory = join(root, name), vault = join(directory, "vault"), source = join(directory, "events.jsonl");
    mkdirSync(directory, { mode: 0o700 });
    const records = item.records.map((record) => ({ id: record.id, text: record.text, occurred_at: record.occurred_at, observed_at: record.observed_at,
      from_subjects: record.subjects.filter((subject) => subject.role === "from").map((subject) => subject.subject_id.slice("quality:".length)),
      to_subjects: record.subjects.filter((subject) => subject.role === "to").map((subject) => subject.subject_id.slice("quality:".length)),
      about_subjects: record.subjects.filter((subject) => subject.role === "about").map((subject) => subject.subject_id.slice("quality:".length)) }));
    writeFileSync(source, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    writeFileSync(`${source}.kizuki-mapping.json`, JSON.stringify({ schema: "kizuki.legacy-events-mapping/v1", table: null,
      source_record_id: { column: "id" }, kind: { const: "message" }, text: { column: "text" },
      occurred_at: { column: "occurred_at", format: "rfc3339" }, observed_at: { column: "observed_at", format: "rfc3339" },
      subjects: ["from", "to", "about"].map((role) => ({ column: `${role}_subjects`, role, namespace: "quality", split: null })),
      sensitivity_hint: { const: "private" }, metadata: { columns: [] } }), { mode: 0o600 });
    const policy = { purposes: ["capture", "recall", "session", "correction", "audit", "derive", "extract", "export"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", sensitivity_floor: "private",
      egress: localOnly ? "local_only" : { model_endpoint: `${endpoint}/chat/completions`, model: MODEL, external_retention: "provider_managed" } };
    await cli<string>(vault, ["init", vault, "--no-default", "--no-service"]);
    await cli<string>(vault, ["import", "import-legacy-events", "--source", source], 1);
    // Trusted synthetic grant setup matches the existing CLI runtime fixture.
    // This is not a policy-file custody proof: UID-mapped execution namespaces
    // correctly fail that separate native POSIX ownership check.
    withLedger(vault, (db) => {
      const connections = listConnections(db);
      assert(connections.length === 1, "fixture enrollment did not create exactly one source");
      assert(readSince(db, null, 1).events.length === 0, "native import captured before source consent");
      setSourceGrant(db, { source_key: connections[0]!.source_key, expected_revision: 0, operation_id: `quality-${name}`, policy });
    });
    await cli<string>(vault, ["import", "import-legacy-events", "--source", source]);
    const ids = withLedger(vault, (db) => mapImportedEvidence(item, readSince(db, null, 9).events));
    writeFileSync(join(vault, ".kizuki/serve.toml"), `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "${endpoint}"\nmodel = "${MODEL}"\ntimeout_ms = 1000\nmax_retries = 0\n`, { mode: 0o600 });
    return { vault, ids, directory };
  }

  function startReplay(item: QualityCase, ids: Record<string, string>, behavior: Replay["behavior"] = "normal") {
    const replay: Replay = { item, ids, response: scripted.responses.find((row) => row.case_id === item.id)!, behavior,
      requests: [], event_roles_present: true, errors: [] };
    active = replay;
    return replay;
  }

  async function consumers(vault: string, item: QualityCase, ids: Record<string, string>): Promise<ConsumerObservation> {
    const inverse = new Map(Object.entries(ids).map(([local, actual]) => [actual, local]));
    const toLocal = (eventIds: string[]) => eventIds.map((id) => inverse.get(id) ?? `unexpected:${id}`).sort();
    const query = await cli<QueryData>(vault, ["query", item.retrieval_query, "--scope", "ledger", "--json", "--degraded"]);
    const canon = await cli<QueryData>(vault, ["query", item.retrieval_query, "--scope", "canon", "--json", "--degraded"]);
    const absent = await cli<QueryData>(vault, ["query", NEGATIVE_QUERY, "--json", "--degraded"]);
    const context = await cli<unknown>(vault, ["context", "--purpose", "session", "--query", item.retrieval_query, "--json"]);
    const expected = item.records.filter((record) => record.text.toLowerCase().includes(item.retrieval_query.toLowerCase())).map((record) => record.id).sort();
    const expectedCanon = item.expected.filter((claim) => claim.bodies.some((body) => body.toLowerCase().includes(item.retrieval_query.toLowerCase())));
    const token = withLedger(vault, (db) => {
      initAgents(db);
      return addAgent(db, `quality-public-${commands.length}`, { ceiling: "public", tools: ["search", "context_packet"] }).token;
    });
    const [owner] = await mcp(vault, [{ name: "search", arguments: { query: item.retrieval_query, scope: "ledger" } }]);
    const [publicResult, publicPacket] = await mcp(vault, [
      { name: "search", arguments: { query: item.retrieval_query } },
      { name: "context_packet", arguments: { query: item.retrieval_query, budget_tokens: 500 } },
    ], token);
    assert(owner !== undefined && publicResult !== undefined && publicPacket !== undefined, "native MCP omitted a consumer result");
    const ledgerRecalled = toLocal(query.hits.map((hit) => hit.doc_id.slice("event:".length)));
    const mcpRecalled = toLocal(owner.quoted.map((quote) => quote.event_id));
    const contextCitations = expected.every((id) => JSON.stringify(context).includes(ids[id]!));
    const publicDisclosures = publicResult.canon.length + publicResult.quoted.length + publicPacket.canon.length + publicPacket.quoted.length +
      Number(item.records.some((record) => JSON.stringify([publicResult, publicPacket]).includes(record.text)));
    const canonMatches = expectedCanon.filter((claim) => canon.hits.some((hit) => hit.authority === "model_inference" && claim.bodies.some((body) => hit.snippet.includes(body)))).map((claim) => claim.id).sort();
    const failures: string[] = [];
    if (canonicalJson(ledgerRecalled) !== canonicalJson(expected)) failures.push("cli_ledger_relevance");
    if (canonicalJson(mcpRecalled) !== canonicalJson(expected)) failures.push("mcp_ledger_relevance");
    if (!contextCitations) failures.push("context_citation_missing");
    if (canonMatches.length !== expectedCanon.length) failures.push("canon_model_claim_missing");
    if (publicDisclosures !== 0) failures.push("public_disclosure");
    if (absent.hits.length !== 0) failures.push("no_result_query_returned_content");
    return { ledger_recalled: ledgerRecalled, expected_ledger: expected, mcp_recalled: mcpRecalled, public_disclosures: publicDisclosures,
      unknown_query_hits: absent.hits.length, context_citations_complete: contextCitations,
      expected_canon: expectedCanon.map((claim) => claim.id).sort(), canon_supported_matches: canonMatches,
      canon: canon.hits.map((hit) => ({ doc_id: hit.doc_id, authority: hit.authority, snippet: hit.snippet })), failures };
  }

  const persistedResponses: QualityResponse[] = [];
  const cases: { case_id: string; status: QualityResponse["status"]; model_requests: number; raw_response_observed: boolean; native_import: boolean;
    event_roles_present: boolean; ids: Record<string, string>; requests: Replay["requests"]; receipt: RunReceipt;
    claims: Claim[]; consumers: { before: ConsumerObservation; after: ConsumerObservation }; failures: string[] }[] = [];
  let recovery: { no_extra_model_calls: boolean; undo_restored_bytes: boolean; restored_recall: boolean } | null = null;
  try {
    if (options.artifact !== undefined) {
      verifyNativeArtifact(options.artifact, sourceSha);
      const copy = join(root, "artifact"); cpSync(options.artifact, copy, { recursive: true, errorOnExist: true });
      verifyNativeArtifact(copy, sourceSha); executable = [join(copy, "kizuki")]; mcpExecutable = [join(copy, "kizuki-mcp")];
      artifactDigest = sha256(readFileSync(executable[0]!));
    }
    for (const item of corpus.cases) {
      const fixture = await setup(item, item.id);
      const replay = startReplay(item, fixture.ids);
      const receipt = await cli<RunReceipt>(fixture.vault, ["serve", "run", "sync", "--json"]);
      assert(replay.errors.length === 0, replay.errors.join("; "));
      assert(replay.requests.length === 1, "native model did not consume the complete fixture case");
      const claims = withLedger(fixture.vault, (db) => listClaims(db, { limit: 64 }).filter((claim) => claim.producer === "model"));
      const status = modelStatus(receipt);
      const inverse = new Map(Object.entries(fixture.ids).map(([local, actual]) => [actual, local]));
      const response = { claims: claims.map((claim) => ({ kind: claim.kind, subject: claim.subject, predicate: claim.predicate, object: claim.object,
        polarity: claim.polarity, body: claim.body, valid_from: claim.valid_from, valid_to: claim.valid_to, confidence: claim.confidence,
        sensitivity: claim.sensitivity, event_ids: claim.provenance.map((id) => inverse.get(id) ?? id) })) };
      persistedResponses.push({ case_id: item.id, status, response: status === "ok" ? response : null,
        usage: { calls: replay.requests.length, input_tokens: null, output_tokens: null },
        dropped: Object.values(receipt.claims_rejected).reduce((sum, value) => sum + value, 0) });
      const before = await consumers(fixture.vault, item, fixture.ids);
      await cli(fixture.vault, ["rebuild", "--json"]);
      const after = await consumers(fixture.vault, item, fixture.ids);
      const failures = [...new Set([...before.failures, ...after.failures])];
      if (status !== "ok") failures.push(`native_${status}`);
      if (item.id === "q10" && !replay.event_roles_present) failures.push("per_event_subject_roles_missing");
      if (canonicalJson(before.ledger_recalled) !== canonicalJson(after.ledger_recalled) || canonicalJson(before.canon) !== canonicalJson(after.canon)) failures.push("rebuild_changed_consumer_result");
      if (receipt.model.calls !== replay.requests.length) failures.push("receipt_call_count_mismatch");
      cases.push({ case_id: item.id, status, model_requests: replay.requests.length, raw_response_observed: true, native_import: true,
        event_roles_present: replay.event_roles_present, ids: fixture.ids, requests: replay.requests, receipt, claims,
        consumers: { before, after }, failures });
      if (item.id === "q01") {
        assert(claims.length === 1, "direct fixture did not file one model claim");
        const initialReceipt = withLedger(fixture.vault, (db) => listCanonReceipts(db, { writer: "loop", limit: 8 })[0]);
        assert(initialReceipt !== undefined, "direct fixture has no canon write receipt");
        const page = join(fixture.vault, initialReceipt.page_path), initialBytes = sha256(readFileSync(page));
        // Remove the model before exercising the deterministic consumers.
        writeFileSync(join(fixture.vault, ".kizuki/serve.toml"), "", { mode: 0o600 });
        const correction = await cli<{ receipt_id: string }>(fixture.vault, ["tell", "Ada now coordinates the Juniper archive.", "--claim", claims[0]!.claim_id, "--json"]);
        const corrected = await cli<QueryData>(fixture.vault, ["query", "Juniper", "--scope", "canon", "--json", "--degraded"]);
        assert(corrected.hits.length > 0 && corrected.hits.every((hit) => hit.authority === "owner_correction"), "native correction did not establish owner authority");
        await cli(fixture.vault, ["undo", correction.receipt_id]);
        const undoRestored = sha256(readFileSync(page)) === initialBytes;
        const backup = join(fixture.directory, "backup"), restored = join(fixture.directory, "restored");
        await cli(fixture.vault, ["export", "--out", backup]);
        await cli(fixture.vault, ["restore", "--from", backup, "--into", restored]);
        await cli(restored, ["rebuild", "--json"]);
        const restoredResult = await cli<QueryData>(restored, ["query", "Orchard", "--scope", "canon", "--json", "--degraded"]);
        recovery = { no_extra_model_calls: replay.requests.length === 1 && replay.errors.length === 0,
          undo_restored_bytes: undoRestored, restored_recall: restoredResult.hits.some((hit) => hit.snippet.includes("Ada is the coordinator for Orchard library.") && hit.authority === "model_inference") };
      }
      active = null;
    }
    async function control(name: "denied" | "unavailable" | "malformed") {
      const fixture = await setup(corpus.cases[0]!, `control-${name}`, name === "denied");
      const replay = startReplay(corpus.cases[0]!, fixture.ids, name === "denied" ? "normal" : name);
      const receipt = await cli<RunReceipt>(fixture.vault, ["serve", "run", "sync", "--json"]);
      assert(replay.errors.length === 0, replay.errors.join("; "));
      const claims = withLedger(fixture.vault, (db) => listClaims(db, { limit: 64 }).filter((claim) => claim.producer === "model").length);
      active = null;
      return { status: name === "denied" && replay.requests.length === 0 ? "denied" : modelStatus(receipt), model_requests: replay.requests.length, claims, receipt };
    }
    const controls = { denied: await control("denied"), unavailable: await control("unavailable"), malformed: await control("malformed"), recovery: recovery! };
    const persistedSet: QualityResponseSet = { ...scripted, corpus_sha256: corpusDigest(persisted), responses: persistedResponses };
    const rawScore = scoreExtraction(corpus, scripted);
    const persistedScore = scoreExtraction(persisted, validateResponseSet(persistedSet, persisted));
    const controlsPassed = controls.denied.status === "denied" && controls.denied.model_requests === 0 && controls.denied.claims === 0 &&
      controls.unavailable.status === "unavailable" && controls.unavailable.model_requests === 1 && controls.unavailable.claims === 0 &&
      controls.malformed.status === "rejected" && controls.malformed.model_requests === 1 && controls.malformed.claims === 0 &&
      Object.values(controls.recovery).every(Boolean);
    return { schema: "kizuki.native-extraction-quality/v1", execution_mode: options.artifact === undefined ? "source_cli" : "copied_native_cli",
      at: new Date().toISOString(), source_sha: sourceSha, source_tree: sourceTree, artifact_sha256: artifactDigest,
      runner_sha256: sha256(readFileSync(import.meta.filename)), source_changes: git("status", "--porcelain").split("\n").filter(Boolean),
      fixture_setup: "native CLI enrollment/import; exact source grant and synthetic public-agent enrollment use public Core; no policy-file custody claim",
      mode: "scripted_contract", model_quality_claim: false, usage_evidence: "fixture omitted provider usage; native zero values do not establish measured zero",
      persisted_time_contract: "RFC0002 section4.2: raw null becomes cited observed_at; no insertion-time normalization",
      raw_score: rawScore, persisted_score: persistedScore, controls_passed: controlsPassed,
      passed: rawScore.passed && persistedScore.passed && controlsPassed && cases.every((row) => row.failures.length === 0),
      cases, controls, commands };
  } finally {
    active = null;
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    assert((args.length === 2 && args[0] === "--out") || (args.length === 4 && args[0] === "--artifact" && args[2] === "--out"), "usage: extraction-quality-native [--artifact DIRECTORY] --out NEW_FILE");
    const report = await runNativeQuality(args.length === 4 ? { artifact: resolve(args[1]!) } : {});
    writeQualityReport(args.at(-1)!, report);
    console.log(report.passed ? "scripted native fixture passed" : "scripted native fixture measured failures; inspect report");
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "native quality evaluation failed");
    process.exitCode = 2;
  }
}
