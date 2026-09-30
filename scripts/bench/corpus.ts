import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LLM_CONTRACT, bindSourceModelPort, createModelProducerV2Port, ensureVaultId, hardenLedgerFile, initVault,
  registerConnection, setSourceGrant,
  type LlmPort,
} from "../../packages/core/src/index";
import { initSearch, openLedger, sealLedger } from "../../packages/core/src/internal";
import { createLegacyEventsConnector, LEGACY_EVENTS_CONNECTOR_ID, type LegacyEventsMapping } from "../../packages/connectors/src/index";

export const EVENTS_PER_TOPIC = 256;
const SOURCE_KEY = "01J00000000000000000000SRC";
const MODEL = "synthetic-benchmark-model";
const ENDPOINT = "https://models.example.test/v1/chat/completions";
const DAY = Date.parse("2020-01-01T00:00:00.000Z");
const MAPPING: LegacyEventsMapping = {
  schema: "kizuki.legacy-events-mapping/v1", table: "records",
  source_record_id: { column: "record_id" }, kind: { const: "note" },
  occurred_at: { column: "at", format: "rfc3339" }, observed_at: { column: "observed", format: "rfc3339" },
  text: { column: "text" }, subjects: [], sensitivity_hint: null, deleted: null,
  metadata: { columns: ["ordinal"] },
};

/** Logical source rows repeat by topic; ids remain distinct and seed changes the content. */
export function sourceRow(index: number, seed: number) {
  const topic = Math.floor(index / EVENTS_PER_TOPIC);
  const label = `Topic${String(topic).padStart(6, "0")}`;
  const variant = (Math.imul(seed ^ topic, 1664525) + 1013904223) >>> 0;
  const text = `${label} defines synthetic pattern ${variant}. Its example is a neutral numbered tile.`;
  const at = new Date(DAY + index * 86_400_000).toISOString();
  return { record_id: `record-${String(index).padStart(7, "0")}`, at, observed: at, text, ordinal: index };
}
export function createSource(path: string, events: number, seed: number): string {
  const source = new Database(path, { create: true });
  const hash = new Bun.CryptoHasher("sha256");
  try {
    source.exec("CREATE TABLE records(record_id TEXT, at TEXT, observed TEXT, text TEXT, ordinal INTEGER) STRICT");
    const insert = source.query("INSERT INTO records VALUES(?,?,?,?,?)");
    source.transaction(() => {
      for (let index = 0; index < events; index++) {
        const row = sourceRow(index, seed);
        hash.update(JSON.stringify(row) + "\n");
        insert.run(row.record_id, row.at, row.observed, row.text, row.ordinal);
      }
    })();
  } finally { source.close(); }
  return hash.digest("hex");
}
export function connector(source: string) {
  return createLegacyEventsConnector({ path: source, format: "sqlite", mapping: MAPPING });
}
export function createVault(vault: string) {
  initVault(vault);
  ensureVaultId(vault);
  writeFileSync(join(vault, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_run = 32\ncanon_writes_per_day = 100000\n[extraction]\nmax_calls_per_day = 100000\nmax_output_tokens_per_day = 1000000000\n", { mode: 0o600 });
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    hardenLedgerFile(join(vault, ".kizuki", "kizuki.db"));
    sealLedger(vault, db);
    registerConnection(db, LEGACY_EVENTS_CONNECTOR_ID, SOURCE_KEY);
    setSourceGrant(db, {
      source_key: SOURCE_KEY, expected_revision: 0, operation_id: "synthetic-benchmark-grant",
      policy: {
        purposes: ["capture", "recall", "derive", "extract", "export"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
        sensitivity_floor: "private", egress: { model_endpoint: ENDPOINT, model: MODEL, external_retention: "provider_managed" },
      },
    });
  } finally { db.close(); }
}
export { SOURCE_KEY };

/** Only the uncontrollable model boundary is scripted; parsing, admission, claims and the writer are real. */
export function scriptedProducer(vault: string) {
  const seen = new Set<string>();
  const llm: LlmPort = {
    descriptor: { id: "kizuki.llm.benchmark", kind: "llm", contract: LLM_CONTRACT, contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: MODEL,
    health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
    async complete(request) {
      const mentions = [], claims = [];
      for (const match of request.messages.map(message => message.content).join("\n").matchAll(/<<<KZ-QUOTE ([0-9a-f]{32}) event:([0-9A-HJKMNP-TV-Z]{26})>>>\n(Topic\d{6})([^\n]*)\n<<<KZ-END \1>>>/g)) {
        const label = match[3]!;
        if (seen.has(label)) continue;
        seen.add(label);
        const id: string = `m${mentions.length}`;
        const anchor = { event_id: match[2]!, start_utf16: 0, end_utf16: label.length };
        mentions.push({ id, label, anchor, candidate_refs: [] });
        for (const [predicate, object] of [
          ["world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }],
          ["concept.label", { kind: "literal", value: label }],
          ["concept.definition", { kind: "literal", value: `${label}${match[4]}` }],
        ] as const) {
          claims.push({ id: `c${claims.length}`, subject: { kind: "mention", id }, predicate, object,
            perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
            context: [], polarity: "positive", body: `${label}${match[4]}`, valid_from: null, valid_to: null,
            temporal_basis: "unknown", confidence: .8, sensitivity: "private", anchors: [anchor] });
        }
      }
      return { text: JSON.stringify({ schema: "kizuki.producer-response/v2", mentions, claims }), model: MODEL, usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };
  const producer = createModelProducerV2Port({
    vault_path: vault, data_dir: join(vault, ".kizuki"), config: {},
    secrets: async () => { throw new Error("benchmark has no secrets"); }, clock: () => new Date().toISOString(), logger: () => undefined,
  }, { llm });
  return bindSourceModelPort(producer, { model_endpoint: ENDPOINT, model: MODEL });
}
export { MODEL };
