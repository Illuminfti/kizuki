import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, type Grant, type SourceGrantPolicy } from "@kizuki/core";
import { createHelpers } from "../../../cli/test/helpers";
import { startApp } from "../../../cli/src/commands/app";
import type { CliIo } from "../../../cli/src/commands";
import { defaultChatCompletion, startFakeEndpoint, type SeenRequest } from "../../../llm/test/fake-endpoint";
import { stdioClient, type StdioClient } from "./two-clients";
import { envelopeOf } from "../client";

export const LABEL = "Orchard request queue";
export const ORIGINAL = `queue.md: ${LABEL} is a queue that stores requests in arrival order.`;
export const REVISED = `queue.md: ${LABEL} orders equal-priority requests by their arrival sequence.`;
export const RICH = ORIGINAL + "\nFrom 2026-10-01T00:00:00.000Z onwards: Orchard release is a project to deliver receipts. We might use format X. Verify delivery receipt: 1. Read the receipt. 2. Check required fields. The project is reportedly blocked by an unavailable loading bay.";
export const BLOCKER = "An unavailable loading bay";
export const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const policy: SourceGrantPolicy = { purposes: ["capture", "recall", "session", "correction", "audit", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };

/** A bounded contract fake, never model quality evidence. It binds actual captured event/handle bytes. */
function extraction(request: SeenRequest): Response {
  const messages = (request.body as { messages: { content: string }[] }).messages;
  const user = messages[1]?.content ?? "";
  const handles = /supplied-handles>>>\n([^\n]+)\n<<<KZ-END/.exec(user)?.[1];
  const events = [...user.matchAll(/<<<KZ-QUOTE ([a-f0-9]{32}) event:([0-9A-HJKMNP-TV-Z]{26})>>>\n([\s\S]*?)\n<<<KZ-END \1>>>/g)];
  if (events.length === 0) return defaultChatCompletion("Synthetic connection works.");
  const refs = JSON.parse(handles ?? "[]") as { id: string; anchors: { event_id: string; start_utf16: number; end_utf16: number }[] }[];
  const claims: unknown[] = [], mentions: unknown[] = [];
  for (const [, , event, text] of events) {
    if (text !== ORIGINAL && text !== REVISED && text !== RICH) throw new Error("unexpected GOLDEN fixture source");
    const handle = refs.find(row => row.anchors.some(anchor => anchor.event_id === event));
    if (handle === undefined) throw new Error("GOLDEN source lacks its connector-bound document handle");
    const anchors = [...handle.anchors, { event_id: event!, start_utf16: 0, end_utf16: text!.length }];
    const specs = [["world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }],
      ["concept.label", { kind: "literal", value: LABEL }], ["concept.definition", { kind: "literal", value: text === RICH ? ORIGINAL : text }]] as const;
    for (const [predicate, object] of specs) claims.push({ id: `c${claims.length}`, subject: { kind: "supplied", id: handle.id }, predicate, object,
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] }, context: [], polarity: "positive",
      body: text, valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.7, sensitivity: "private", anchors });
  }
  const richEvent = events.find(row => row[3] === RICH);
  if (richEvent) {
    const event = richEvent[2]!, whole = { event_id: event, start_utf16: 0, end_utf16: RICH.length };
    const mention = (label: string) => { const id = `m${mentions.length}`, start = RICH.indexOf(label); const anchor = { event_id: event, start_utf16: start, end_utf16: start + label.length }; mentions.push({ id, label, anchor, candidate_refs: [] }); return { ref: { kind: "mention", id }, anchor }; };
    const situation = mention("Orchard release"), decision = mention("format X"), procedure = mention("Verify delivery receipt");
    const add = (node: ReturnType<typeof mention>, predicate: string, object: unknown, related?: ReturnType<typeof mention>, mode = "asserted") => claims.push({ id: `c${claims.length}`, subject: node.ref, predicate, object,
      perspective: { holder: null, speaker: null, addressee: null, mode, interpretation: "explicit", anchors: [] }, context: [], polarity: "positive", body: predicate,
      valid_from: "2026-10-01T00:00:00.000Z", valid_to: null, temporal_basis: "explicit", confidence: .7, sensitivity: "private", anchors: [node.anchor, ...(related ? [related.anchor] : []), whole] });
    const vocabulary = (id: string) => ({ kind: "vocabulary", ref: { kind: "vocabulary", id } }), literal = (value: string) => ({ kind: "literal", value });
    add(situation, "world.kind", vocabulary("world/situation")); add(situation, "situation.label", literal("Orchard release")); add(situation, "situation.objective", literal("Deliver receipts"));
    add(situation, "situation.blocker", literal(BLOCKER), undefined, "reported");
    add(situation, "situation.has_decision", { kind: "subject", ref: decision.ref }, decision);
    add(decision, "world.kind", vocabulary("world/decision")); add(decision, "decision.label", literal("Receipt format"));
    // Deliberate model mistake: the source says might. The owner must be able to correct this exact mode.
    add(decision, "decision.status", vocabulary("decision/decided"));
    add(procedure, "world.kind", vocabulary("world/procedure")); add(procedure, "procedure.label", literal("Verify delivery receipt"));
    add(procedure, "procedure.step", literal("1. Read the receipt.")); add(procedure, "procedure.step", literal("2. Check required fields."));
  }
  return defaultChatCompletion(JSON.stringify({ schema: "kizuki.producer-response/v2", mentions, claims }));
}

export async function goldenApp(options: { rich?: boolean } = {}) {
  const h = createHelpers(), env = h.isolatedEnv(), notes = h.tempDir("golden-notes-"), vault = join(env.HOME!, "Kizuki");
  const file = join(notes, "queue.md"); writeFileSync(file, options.rich ? RICH : ORIGINAL);
  let summaryGate: (() => Promise<void>) | undefined;
  let extractionCalls = 0, summaryCalls = 0;
  const endpoint = startFakeEndpoint(async request => {
    const system = (request.body as { messages: { content: string }[] }).messages[0]?.content ?? "";
    if (system.includes('kizuki.consolidation-response/v1')) {
      summaryCalls++; await summaryGate?.();
      return defaultChatCompletion(JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: null }));
    }
    extractionCalls++; return extraction(request);
  });
  const io: CliIo = { env, vaultOverride: null, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: () => {}, err: () => {}, prompt: async () => { throw new Error("unexpected GOLDEN prompt"); } };
  let token = "";
  const app = await startApp(io, { noService: true }, async url => { token = new URL(url).hash.slice("#token=".length); });
  const clients: StdioClient[] = [];
  async function call(route: string, body: unknown = {}): Promise<any> {
    const response = await fetch(`${app.url}/app/v1/${route}`, { method: "POST", headers: { origin: app.url, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json() as any;
    expect(value.error, `App ${route}`).toBeUndefined(); expect(value.ok, `App ${route}`).toBe(true);
    return value.data;
  }
  async function done(id: string): Promise<any> {
    for (let count = 0; count < 1000; count++) { const result = await call("operation", { id }); if (result.state !== "running") { expect(result.state).toBe("succeeded"); return result.result; } await Bun.sleep(10); }
    throw new Error("GOLDEN App operation deadline");
  }
  const operate = async (route: string, body: unknown = {}) => done((await call(route, body)).operation_id);
  const childEnv = Object.fromEntries(Object.entries(env).filter((row): row is [string, string] => row[1] !== undefined));
  async function owner(targetVault = vault) { const client = await stdioClient(targetVault, ["--owner"], childEnv); clients.push(client); return client; }
  const peerGrant: Grant = { ...OWNER_AGENT_GRANT, ceiling: "private", deny_classes: [], tools: ["world_view"], rate_limit_per_minute: 300, relay_owner_corrections: true };
  async function agent(name: string, grant = peerGrant) {
    const enrolled = await operate("agent_enroll", { name, grant, operation_id: `${name}-enroll` });
    const args = enrolled.agent.mcp.args as string[];
    const tokenRef = args[args.indexOf("--token-ref") + 1]!;
    expect(tokenRef.startsWith("file:")).toBe(true);
    const client = await stdioClient(vault, ["--token-ref", tokenRef], childEnv); clients.push(client); return client;
  }
  const peer = () => agent("golden-b");
  async function close() { for (const client of clients.reverse()) await client.close(); await app.close(); endpoint.stop(); h.cleanup(); }
  return { h, env, vault, file, notes, endpoint, call, done, operate, owner, peer, agent, peerGrant, close,
    counts: () => ({ extractionCalls, summaryCalls }),
    holdSummaries() {
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      summaryGate = async () => { entered(); await waiting; };
      return { started, release: () => { summaryGate = undefined; release(); } };
    },
    async initialize() {
      await operate("initialize");
      const empty = await call("model_status");
      const model = await call("model_save", { expected_revision: empty.revision, selection: { kind: "openai_compatible", base_url: endpoint.base_url, model: "synthetic-golden" }, credential: { action: "replace", value: "synthetic-golden-key" } });
      await operate("model_test", { expected_revision: model.revision });
      const source = (await operate("enroll", { provider: "markdown", path: notes })).source_key;
      await call("consent", { source_key: source, expected_revision: 0, operation_id: "golden-local-consent", policy });
      await operate("capture", { source_key: source, mode: "backfill" });
      const before = endpoint.requests.length, local = await operate("run_pass");
      expect(local.run.model_calls).toBe(0); expect(endpoint.requests.length).toBe(before);
      await call("source_model_consent", { source_key: source, expected_revision: 1, expected_model_revision: model.revision, operation_id: "golden-model-consent", allow: true });
      const initial = await operate("run_pass"); expect(initial.run.claims_extracted).toBe(options.rich ? 15 : 3); expect(initial.run.canon_writes).toBeGreaterThan(0);
      return { source, initial };
    },
  };
}
export async function world(client: StdioClient, input: Record<string, unknown>, response_contract = "kizuki.envelope/v2"): Promise<any> {
  const result = await client.call("world_view", { ...WHEN, ...input, response_contract });
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  const envelope = envelopeOf(result); expect(envelope.schema).toBe(response_contract); return envelope.data;
}
