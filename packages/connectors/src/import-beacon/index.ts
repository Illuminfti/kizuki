import { compareRfc3339, freezeManifest, isPlainObject, isRfc3339, policyForConnector, validateEventInput } from "@kizuki/core";
import type { CaptureEventInput, Connector, Cursor, Manifest, PurgePlan, SecretResolver } from "@kizuki/core";
import { notSupported, KizukiError } from "../errors";
import type { ImportParseResult, ImportRecordError } from "../import-report";
import { IMPORT_SNAPSHOT_CURSOR_SCHEMA, runSnapshot, snapshotHealth } from "../import-snapshot";
import { encodeSourceRecordId, sha256Hex } from "../source-id";
import { requireKnownKeys, requirePathConfig } from "../util";
import { BEACON_FIXTURE_EXPORT } from "./fixture";

export { BEACON_FIXTURE_EXPORT } from "./fixture";
export const BEACON_IMPORT_CONNECTOR_ID = "kizuki.import-beacon" as const;
export interface BeaconImportConfig { path: string }

// Pinned Beacon 793524a writes at most 64 KiB per record and rotates at 10 MiB.
// Kizuki reads one explicitly selected snapshot, never follows rotation paths.
export const MAX_BEACON_RECORD_BYTES = 64 * 1024;
export const MAX_BEACON_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 20_000;
const ACTIONS = new Set([
  "session.started", "session.ended", "session.context", "session.status", "session.summary",
  "prompt.submitted", "agent.message", "agent.reasoning", "tool.invoked", "tool.completed", "tool.failed",
  "command.executed", "file.read", "file.modified", "mcp.tool_invoked", "token.usage",
  "approval.requested", "approval.allowed", "approval.denied", "subagent.started", "subagent.stopped",
]);

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1", connector_id: BEACON_IMPORT_CONNECTOR_ID, version: "0.1.0",
  contract_minor: 1, implementation: "@kizuki/connectors", allowed_egress: [],
  cursor_schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA, kinds: ["agent_runtime"],
  capabilities: { backfill: true, sync: true, tombstones: false, purge: false, fixture: true },
  required_secrets: [], emits_sensitivity_hint: false, auth_modes: ["none"],
  ...policyForConnector(BEACON_IMPORT_CONNECTOR_ID),
});
const SNAPSHOT = { connectorId: BEACON_IMPORT_CONNECTOR_ID, parse: parseBeaconExport, maxBytes: MAX_BEACON_EXPORT_BYTES };

export class BeaconImportConnector implements Connector {
  readonly path: string;
  constructor(config: BeaconImportConfig) {
    this.path = requirePathConfig(config, BEACON_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, BEACON_IMPORT_CONNECTOR_ID, ["path"]);
  }
  manifest() { return MANIFEST; }
  health() { return snapshotHealth(this.path, SNAPSHOT); }
  async connect(_resolve: SecretResolver): Promise<void> {}
  backfill(cursor: Cursor | null) { return runSnapshot(this.path, cursor, SNAPSHOT); }
  sync(cursor: Cursor | null) { return this.backfill(cursor); }
  async revoke(): Promise<void> {}
  async purgeSource(_subject_id: string): Promise<PurgePlan> { return notSupported(BEACON_IMPORT_CONNECTOR_ID, "purge"); }
  async fixture(): Promise<CaptureEventInput[]> {
    return parseBeaconExport(BEACON_FIXTURE_EXPORT.map(record => JSON.stringify(record)).join("\n"), "2026-09-21T13:00:00.000Z").events;
  }
}
export function createBeaconImportConnector(config: BeaconImportConfig): BeaconImportConnector { return new BeaconImportConnector(config); }

// Only called after Core's exact-JSON metadata validator has bounded depth,
// keys, arrays and strings. Canonical object order makes formatting-only
// export changes replays; array order remains meaningful source evidence.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function optionalEnum(value: unknown, allowed: string[]): boolean { return value === undefined || value === "" || (typeof value === "string" && allowed.includes(value)); }

function normalize(raw: unknown, observedAt: string): { event: CaptureEventInput } | { code: string } {
  if (!isPlainObject(raw)) return { code: "not_object" };
  if (raw["vendor"] !== "beacon" || raw["product"] !== "endpoint-agent" || raw["schema_version"] !== "1.0") return { code: "unsupported_schema" };
  const info = raw["event"], harness = raw["harness"], endpoint = raw["endpoint"];
  if (!isPlainObject(info) || !isPlainObject(harness) || !isPlainObject(endpoint) || info["kind"] !== "agent_runtime" ||
      !nonempty(endpoint["os"]) || !isRfc3339(raw["timestamp"]) || !nonempty(info["category"]) ||
      !["info", "low", "medium", "high", "critical"].includes(raw["severity"] as string) ||
      !optionalEnum(info["fidelity"], ["observed", "inferred"]) ||
      !optionalEnum(harness["collection_method"], ["hook", "poll", "otlp", "plugin"]) ||
      !optionalEnum(raw["origin"], ["local", "cloud", "ci"]) ||
      (raw["sequence"] !== undefined && (!Number.isSafeInteger(raw["sequence"]) || (raw["sequence"] as number) < 1)) ||
      (info["id"] !== undefined && !nonempty(info["id"]))) return { code: "invalid_record" };
  if (harness["name"] !== "claude_code" && harness["name"] !== "codex") return { code: "unsupported_harness" };
  if (typeof info["action"] !== "string" || !ACTIONS.has(info["action"])) return { code: "unsupported_action" };

  const draft: CaptureEventInput = {
    schema: "kizuki.event/v1", connector_id: BEACON_IMPORT_CONNECTOR_ID, source_record_id: "pending",
    kind: "agent_runtime", occurred_at: raw["timestamp"], observed_at: observedAt, text: "",
    subjects: [], sensitivity_hint: "private", deleted: false, attachments: [],
    // Imported authority, origin, fidelity, approval and outcome claims never
    // become host fields. Every upstream field remains within source evidence.
    metadata: { beacon: { schema: "kizuki.beacon-import/v1", record: raw } },
  };
  const checked = validateEventInput(draft);
  if (!checked.ok) return { code: "invalid_record" };
  const record = ordered(raw) as Record<string, unknown>;
  const canonical = JSON.stringify(record);
  const id = typeof info["id"] === "string" ? encodeSourceRecordId(["event", harness["name"], info["id"]])
    : encodeSourceRecordId(["content", harness["name"], `sha256:${sha256Hex(canonical)}`]);
  // Explicitly captured system instructions stay in original source metadata;
  // they are not presented as runtime task text or instructions to Kizuki.
  const textRecord = { ...record };
  if (isPlainObject(record["gen_ai"]) && Object.hasOwn(record["gen_ai"], "system_instructions")) {
    const { system_instructions: _captured, ...evidence } = record["gen_ai"];
    textRecord["gen_ai"] = evidence;
  }
  const result = validateEventInput({ ...checked.value, source_record_id: id,
    text: `Beacon runtime source report (unverified):\n${JSON.stringify(textRecord)}` });
  return result.ok ? { event: result.value } : { code: "invalid_record" };
}

function writerSequence(event: CaptureEventInput): number | null {
  const beacon = event.metadata["beacon"];
  if (!isPlainObject(beacon) || !isPlainObject(beacon["record"])) return null;
  const sequence = beacon["record"]["sequence"];
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}

/** Timestamp is evidence; the optional writer sequence provides a deterministic equal-time key. */
function compareEvents(left: CaptureEventInput, right: CaptureEventInput): number {
  const timestamp = compareRfc3339(left.occurred_at, "Beacon timestamp", right.occurred_at, "Beacon timestamp");
  if (timestamp !== 0) return timestamp;
  // Missing writer sequence is an explicit deterministic bucket, not a claim
  // that the event preceded any other event in Beacon's causal history.
  const leftSequence = writerSequence(left) ?? 0, rightSequence = writerSequence(right) ?? 0;
  if (leftSequence !== rightSequence) {
    return leftSequence < rightSequence ? -1 : 1;
  }
  return left.source_record_id < right.source_record_id ? -1 : left.source_record_id > right.source_record_id ? 1 : 0;
}

/** Beacon's normalized runtime.jsonl, not a native harness transcript reader. */
export function parseBeaconExport(source: string, observedAt: string): ImportParseResult {
  if (Buffer.byteLength(source, "utf8") > MAX_BEACON_EXPORT_BYTES) throw new KizukiError("parse_error", "Beacon export exceeds the import byte limit");
  const errors: ImportRecordError[] = [];
  const events = new Map<string, CaptureEventInput>();
  const conflicts = new Set<string>();
  let start = 0, lineNumber = 0;
  while (start < source.length) {
    if (++lineNumber > MAX_RECORDS) throw new KizukiError("parse_error", "Beacon export exceeds the import line limit");
    const end = source.indexOf("\n", start);
    const line = source.slice(start, end === -1 ? source.length : end);
    start = end === -1 ? source.length : end + 1;
    if (line.trim() === "") continue;
    const location = `line:${lineNumber}`;
    const fail = (code: string, reason = "Beacon record was not imported") => errors.push({ location, code, reason });
    if (Buffer.byteLength(line, "utf8") > MAX_BEACON_RECORD_BYTES) { fail("record_limit"); continue; }
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { fail("invalid_json"); continue; }
    const normalized = normalize(raw, observedAt);
    if ("code" in normalized) { fail(normalized.code); continue; }
    const event = normalized.event, prior = events.get(event.source_record_id);
    if (conflicts.has(event.source_record_id)) continue;
    if (prior !== undefined && JSON.stringify(ordered(prior.metadata)) !== JSON.stringify(ordered(event.metadata))) {
      events.delete(event.source_record_id); conflicts.add(event.source_record_id);
      fail("duplicate_id", "conflicting Beacon record identity"); continue;
    }
    events.set(event.source_record_id, event);
  }
  return { events: [...events.values()].sort(compareEvents), errors };
}
