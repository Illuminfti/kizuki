import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER, addAgent, authenticate, bindSourceModelPort, createBudgetTracker,
  createModelProducerV2Port, initAgents, initVault, readSince, registerConnection,
  rebuildRetrieval, runBackfill, runWritePass, seedConnectorSensitivity, serveCorrect, servePropose,
  serveWorldView, setSourceGrant,
} from "../../../packages/core/src/index";
import type { LlmPort, ServeContext } from "../../../packages/core/src/index";
import { openLedger } from "../../../packages/core/src/testing";
import { LegacyEventsConnector } from "../../../packages/connectors/src/index";
import type { RichClaimDraft, ProducerV2SuppliedRef } from "../../../packages/core/src/contracts/producer-v2";
import { AS_OF, persona } from "./persona";
import type { PersonaSize, RecordSpec } from "./persona";

const ENDPOINT = "https://model.example.test/v1/chat/completions";
const MODEL = "scripted-persona-v1";
const CONNECTOR = "kizuki.import-legacy-events";

function recordText(record: RecordSpec): string {
  return `${record.label}: ${record.claims.map(claim => claim.value).join("; ")}.`;
}

/** Real model producer/parser over an in-process scripted LLM: no transport or egress. */
function scriptedModel(records: RecordSpec[]): LlmPort {
  return {
    descriptor: { id: "kizuki.llm.fresh-agent-fixture", kind: "llm", contract: "kizuki.llm/v1",
      contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: MODEL,
    health: async () => ({ status: "ready", detail: {} }),
    close: async () => {},
    async complete(request) {
      const user = request.messages.find(message => message.role === "user")!.content;
      const suppliedBlock = /supplied-handles>>>\n(.*?)\n<<<KZ-END/s.exec(user)?.[1];
      if (suppliedBlock === undefined) throw new Error("fixture supplied handles missing");
      const supplied = JSON.parse(suppliedBlock) as ProducerV2SuppliedRef[];
      const claims: RichClaimDraft[] = [];
      for (const event of user.matchAll(/event:([0-9A-HJKMNP-TV-Z]{26})>>>\n(.*?)\n<<<KZ-END/gs)) {
        const eventId = event[1]!, text = event[2]!;
        const record = records.find(candidate => recordText(candidate) === text);
        // Native corrections/proposals are excluded from extraction by Core.
        if (record === undefined) throw new Error("unexpected fixture model input");
        const ref = supplied.find(candidate => candidate.anchors.some(anchor => anchor.event_id === eventId));
        if (ref === undefined) throw new Error("fixture subject handle missing");
        const anchor = ref.anchors.find(candidate => candidate.event_id === eventId)!;
        const drafts = [...record.claims];
        if (record.kind !== undefined) drafts.unshift({ predicate: `${record.kind}.label`, value: record.label });
        for (const [index, draft] of drafts.entries()) {
          claims.push({ id: `${record.id}-${index}`, subject: { kind: "supplied", id: ref.id },
            predicate: draft.predicate, object: { kind: "literal", value: draft.value },
            perspective: { holder: null, speaker: null, addressee: null, mode: draft.mode ?? "asserted", interpretation: "explicit", anchors: [] },
            context: [], polarity: "positive", body: `${record.label}: ${draft.value}.`,
            valid_from: record.at, valid_to: draft.until ?? null, temporal_basis: "explicit",
            confidence: 0.8, sensitivity: record.sensitivity ?? "personal", anchors: [anchor],
          });
        }
        if (record.kind !== undefined) claims.push({
          ...claims[claims.length - 1]!, id: `${record.id}-kind`, predicate: "world.kind",
          object: { kind: "vocabulary", ref: { kind: "vocabulary", id: `world/${record.kind}` } },
          body: `${record.label} is a ${record.kind}.`,
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
          valid_to: null,
        });
      }
      const text = JSON.stringify({ schema: "kizuki.producer-response/v2", mentions: [], claims });
      return { text, model: MODEL, usage: { input_tokens: Math.ceil(user.length / 4), output_tokens: Math.ceil(text.length / 4) } };
    },
  };
}

export function discoveredCards(ctx: ServeContext, kind: "concept" | "situation", label: string) {
  const query = { valid: { kind: "all" }, knownAt: { kind: "current" } };
  const discovery = serveWorldView(ctx, { ...query, operation: kind === "concept" ? "find_concepts" : "find_situations", label });
  const result = discovery.data;
  if ("status" in result || result.result.status === "unavailable" || !("matches" in result.result.data)) return [discovery];
  return [discovery, ...result.result.data.matches.map(match => serveWorldView(ctx, { ...query, operation: kind, [kind]: match.ref }))];
}

export async function generateVault(root: string, size: PersonaSize) {
  const scenario = persona(size), vaultPath = join(root, "vault");
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  const inputs = join(root, "inputs");
  mkdirSync(inputs);
  let producer: ReturnType<typeof createModelProducerV2Port> | undefined;
  try {
    initAgents(db);
    const mapping = { schema: "kizuki.legacy-events-mapping/v1", source_record_id: { column: "id" },
      kind: { const: "note" }, occurred_at: { column: "at", format: "rfc3339" },
      observed_at: { column: "observed", format: "rfc3339" }, text: { column: "text" },
      subjects: [{ column: "label", role: "about", namespace: "persona", split: null }],
      sensitivity_hint: { column: "sensitivity", values: { personal: "personal", private: "private" } },
      metadata: { columns: [] },
    };
    writeFileSync(join(inputs, "mapping.json"), JSON.stringify(mapping));
    const importReceipts = [];
    for (const group of ["shared", "scope", "ceiling", "withheld"] as const) {
      const selected = scenario.records.filter(record =>
        (record.withheld ? "withheld" : record.sensitivity === "private" ? "ceiling" : record.subject === "family" ? "scope" : "shared") === group);
      const path = join(inputs, `${group}.jsonl`);
      writeFileSync(path, selected.map(record => JSON.stringify({ id: record.id, at: record.at, observed: record.at,
        label: record.label, text: recordText(record), sensitivity: record.sensitivity ?? "personal" })).join("\n") + "\n");
      const connector = new LegacyEventsConnector({ path, format: "jsonl", mapping: join(inputs, "mapping.json") });
      const sourceKey = `fresh-agent-${group}`;
      registerConnection(db, CONNECTOR, sourceKey);
      // Host policy from the synthetic source class; the model cannot lower it.
      seedConnectorSensitivity(db, { connector_id: CONNECTOR, source_key: sourceKey }, {
        default_sensitivity: group === "ceiling" ? "private" : "personal", sensitivity_floor: "personal",
      });
      setSourceGrant(db, { source_key: sourceKey, expected_revision: 0, operation_id: `grant-${group}`,
        policy: { purposes: ["capture", "derive", "extract", "correction", "export", ...(group === "withheld" ? [] : ["recall" as const])],
          allowed_fields: ["text", "subjects", "metadata", "attachments"], retention: "persistent_owned_until_revoked",
          sensitivity_floor: group === "ceiling" ? "private" : "personal",
          egress: { model_endpoint: ENDPOINT, model: MODEL, external_retention: "provider_managed" } },
      });
      const receipt = await runBackfill(db, connector, CONNECTOR, sourceKey);
      if (receipt.errors.length > 0 || receipt.stored !== selected.length) throw new Error("fixture import failed");
      const repeat = await runBackfill(db, connector, CONNECTOR, sourceKey);
      if (repeat.errors.length > 0 || repeat.stored !== 0) throw new Error("fixture import was not idempotent");
      importReceipts.push({ source: group, stored: receipt.stored, repeat_stored: repeat.stored });
    }
    producer = bindSourceModelPort(createModelProducerV2Port({ vault_path: vaultPath, data_dir: inputs,
      config: {}, secrets: async () => { throw new Error("fixture has no credentials"); }, clock: () => AS_OF, logger: () => {},
    }, { llm: scriptedModel(scenario.records) }), { model_endpoint: ENDPOINT, model: MODEL });
    const passes = [];
    for (let step = 0; step < 32; step += 1) {
      const result = await runWritePass(db, vaultPath, { producer, model_ref: MODEL, claims: { db },
        budget: createBudgetTracker({ canon_writes_per_run: 64 }) });
      if (result.errors.length > 0 || result.stopped !== null) throw new Error(`fixture extraction failed: ${JSON.stringify(result)}`);
      passes.push({ claims: result.claims_extracted, writes: result.canon_writes, calls: result.model.calls });
      if (result.model.calls === 0 && result.canon_writes === 0) break;
      if (step === 31) throw new Error("fixture extraction did not settle");
    }
    const ctx = { db, vaultPath, principal: OWNER };
    const event = readSince(db, null, 1000).events.find(item => item.source_record_id === "identity");
    if (event === undefined) throw new Error("fixture identity missing");
    const proposed = await servePropose(ctx, { kind: "claim", body: "Ada collaborates with Grace.",
      subject: "persona:ada", subjects: ["persona:ada"], predicate: "relation.knows", object: "Grace", provenance: [event.event_id] });
    if (proposed.data?.outcome !== "stored") throw new Error("fixture proposal failed");
    const cards = discoveredCards(ctx, "situation", "Orchard");
    const card = cards.find(envelope => "result" in envelope.data && envelope.data.result.status !== "unavailable" &&
      "blocker" in envelope.data.result.data && envelope.data.result.data.blocker?.object.kind === "literal" &&
      envelope.data.result.data.blocker.object.value === "waiting for the paint samples");
    if (card === undefined || !("result" in card.data) || card.data.result.status === "unavailable" || !("blocker" in card.data.result.data) || card.data.result.data.blocker === null) throw new Error("fixture blocker missing");
    const corrected = await serveCorrect(ctx, { statement: "waiting for the load test", target: { world_claim: card.data.result.data.blocker.claim } });
    if (corrected.data?.claim_id === null || corrected.data?.claim_id === undefined) throw new Error("fixture correction failed");
    await producer.close();
    producer = undefined;
    await rebuildRetrieval(db, vaultPath, undefined, { layer: "search" });
    const { token } = addAgent(db, "fresh-agent", { ceiling: "personal", subjects: ["persona:ada", "persona:grace", "persona:orchard", "persona:bayes"],
      types: null, tools: ["search", "context_packet", "world_view"], rate_limit_per_minute: 1000, relay_owner_corrections: false });
    const principal = authenticate(db, token);
    if (principal === null) throw new Error("fixture authentication failed");
    return { ...scenario, db, vaultPath, token, principal, build: { imports: importReceipts, extraction: passes,
      propose: proposed.data.outcome, correct: "committed" as const } };
  } catch (error) {
    await producer?.close();
    db.close();
    throw error;
  }
}
