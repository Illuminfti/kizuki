import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { RETRIEVAL_CONTRACT, RETRIEVAL_CONTRACT_MINOR } from "../contracts/retrieval";
import { PortError } from "../contracts/ports";
import { tableExists } from "../ledger/schema";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";

export interface ConfiguredRetrieval {
  id: string;
  config: Record<string, unknown>;
}

export interface RetrievalPortState {
  kind: string;
  port_id: string;
  contract: string;
  contract_minor: number;
  space: string | null;
  bound_at: string;
}

const CONFIG_REL = join(".kizuki", "serve.toml");
const CONFIG_BYTES = 65_536;
const CANONICAL_IDS: Readonly<Record<string, string>> = {
  "kizuki.retrieval.fts5": "kizuki.retrieval.fts5",
  "kizuki.retrieval.embedded-pg": "kizuki.retrieval.embedded-pg",
  "kizuki.retrieval.pg": "kizuki.retrieval.embedded-pg",
};

const PORT_STATE_SQL = `CREATE TABLE IF NOT EXISTS port_state (
  kind TEXT PRIMARY KEY,
  port_id TEXT NOT NULL,
  contract TEXT NOT NULL,
  contract_minor INTEGER NOT NULL,
  space TEXT,
  bound_at TEXT NOT NULL
) STRICT`;

function configPath(vaultPath: string): string {
  return join(vaultPath, CONFIG_REL);
}

function canonicalRetrievalId(id: string): string {
  const canonical = CANONICAL_IDS[id];
  if (canonical === undefined) {
    throw new PortError("config_invalid", `unknown retrieval port ${id}`, false);
  }
  return canonical;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => isPlainObject(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

function withoutRetrieval(parsed: Record<string, unknown>): string {
  const copy = { ...parsed };
  if (isPlainObject(copy.ports)) {
    const ports = { ...copy.ports };
    delete ports.retrieval;
    if (Object.keys(ports).length === 0) delete copy.ports;
    else copy.ports = ports;
  }
  return stable(copy);
}

function parseToml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > CONFIG_BYTES) {
    throw new PortError("config_invalid", "retrieval configuration is unreadable", false);
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new PortError("config_invalid", "retrieval configuration is unreadable", false);
  }
  if (!isPlainObject(parsed)) {
    throw new PortError("config_invalid", "retrieval configuration is invalid", false);
  }
  if (parsed["ports"] !== undefined && !isPlainObject(parsed["ports"])) {
    throw new PortError("config_invalid", "ports must be a table", false);
  }
  return parsed;
}

function writeAtomicToml(path: string, contents: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.serve.toml.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Edit only an ordinary [ports] retrieval assignment. Ambiguous TOML is refused. */
export function editRetrievalPortToml(text: string | null, portId: string): string {
  const id = canonicalRetrievalId(portId);
  const assignment = `retrieval = ${JSON.stringify(id)}\n`;
  if (text === null || text.length === 0) return `[ports]\n${assignment}`;
  if (text.includes('"""') || text.includes("'''")) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  const before = parseToml(text);
  const existing = isPlainObject(before.ports) ? before.ports.retrieval : undefined;
  if (isPlainObject(existing) && Object.keys(existing).some((key) => key !== "id")) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let section = "";
  let portsHeader = -1;
  let retrievalHeader = -1;
  let retrievalHeaderEnd = lines.length;
  let retrievalAssignment = -1;
  let tableId = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      const header = line.match(/^\s*\[([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\]\s*(?:#.*)?(?:\r?\n)?$/);
      if (!header) throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
      if (section === "ports.retrieval" && retrievalHeaderEnd === lines.length) retrievalHeaderEnd = index;
      section = header[1]!;
      if (section === "ports") portsHeader = index;
      if (section === "ports.retrieval") retrievalHeader = index;
      if (section.startsWith("ports.retrieval.")) {
        throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
      }
    } else if (section === "ports" && /^\s*retrieval\s*=/.test(line)) {
      if (retrievalAssignment !== -1) {
        throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
      }
      retrievalAssignment = index;
    } else if (section === "ports.retrieval" && /^\s*id\s*=/.test(line)) {
      if (tableId !== -1) throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
      tableId = index;
    }
  }
  if (retrievalHeader !== -1 && retrievalAssignment !== -1) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  if (existing !== undefined && retrievalHeader === -1 && retrievalAssignment === -1) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  let result: string;
  if (retrievalAssignment !== -1) {
    result = [...lines.slice(0, retrievalAssignment), assignment, ...lines.slice(retrievalAssignment + 1)].join("");
  } else if (retrievalHeader !== -1) {
    result = [...lines.slice(0, retrievalHeader), `[ports]\n${assignment}`, ...lines.slice(retrievalHeaderEnd)].join("");
  } else if (portsHeader !== -1) {
    result = [...lines.slice(0, portsHeader + 1), assignment, ...lines.slice(portsHeader + 1)].join("");
  } else {
    const kept = lines.join("");
    result = `${kept}${kept.length > 0 && !kept.endsWith("\n") ? "\n" : ""}[ports]\n${assignment}`;
  }
  const after = parseToml(result);
  if (withoutRetrieval(before) !== withoutRetrieval(after)) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  const selected = isPlainObject(after.ports) ? after.ports.retrieval : undefined;
  const selectedId = isPlainObject(selected) ? selected.id : selected;
  if (selectedId !== id) {
    throw new PortError("config_invalid", "retrieval configuration is unsupported", false);
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function readRetrievalEngineSpace(vaultPath: string, portId: string): string | null {
  if (portId === "kizuki.retrieval.fts5") return null;
  const path = join(vaultPath, ".kizuki", "retrieval", portId, "engine.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) return null;
    return typeof parsed.space === "string" ? parsed.space : null;
  } catch {
    return null;
  }
}

function recordPortState(db: Database, state: RetrievalPortState): void {
  db.exec(PORT_STATE_SQL);
  db.query(
    `INSERT INTO port_state(kind, port_id, contract, contract_minor, space, bound_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       port_id = excluded.port_id,
       contract = excluded.contract,
       contract_minor = excluded.contract_minor,
       space = excluded.space,
       bound_at = excluded.bound_at`,
  ).run(state.kind, state.port_id, state.contract, state.contract_minor, state.space, state.bound_at);
}

export function readRetrievalPortState(db: Database, kind = "retrieval"): RetrievalPortState | null {
  if (!tableExists(db, "port_state")) return null;
  const row = db.query<RetrievalPortState, [string]>(
    `SELECT kind, port_id, contract, contract_minor, space, bound_at FROM port_state WHERE kind = ?`,
  ).get(kind);
  return row ?? null;
}

/** Shared selection for CLI, daemon and MCP; opening an engine is a host concern. */
export function loadConfiguredRetrieval(vaultPath: string): ConfiguredRetrieval {
  const path = configPath(vaultPath);
  const fallback = { id: "kizuki.retrieval.fts5", config: {} };
  if (!existsSync(path)) return fallback;
  let parsed: unknown;
  try {
    if (statSync(path).size > CONFIG_BYTES) throw new Error("oversized config");
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PortError("config_invalid", "retrieval configuration is unreadable", false);
  }
  if (!isPlainObject(parsed)) throw new PortError("config_invalid", "retrieval configuration is invalid", false);
  if (parsed["ports"] === undefined) return fallback;
  if (!isPlainObject(parsed["ports"])) throw new PortError("config_invalid", "ports must be a table", false);
  const value = parsed["ports"]["retrieval"];
  if (value === undefined) return fallback;
  const table = isPlainObject(value) ? value : { id: value };
  if (typeof table["id"] !== "string" || table["id"].length === 0) {
    throw new PortError("config_invalid", "retrieval must select an id", false);
  }
  const { id, ...config } = table;
  // Compatibility for the previously accepted configuration spelling. The
  // running port and receipts always identify the actual implementation.
  return { id: id === "kizuki.retrieval.pg" ? "kizuki.retrieval.embedded-pg" : id, config };
}

/**
 * Activate a rebuilt retrieval engine as the vault default. Writes serve.toml
 * first, then port_state. A later SQL failure restores the previous file so
 * the command cannot return success with a flipped default.
 */
export function persistConfiguredRetrieval(
  db: Database,
  vaultPath: string,
  portId: string,
  options: { space?: string | null; now?: string } = {},
): RetrievalPortState {
  const id = canonicalRetrievalId(portId);
  const path = configPath(vaultPath);
  const previous = existsSync(path) ? readFileSync(path) : null;
  const next = editRetrievalPortToml(previous === null ? null : previous.toString("utf8"), id);
  const boundAt = options.now ?? new Date().toISOString();
  if (!isRfc3339(boundAt)) {
    throw new PortError("config_invalid", "retrieval port_state bound_at is not RFC3339", false);
  }
  const state: RetrievalPortState = {
    kind: "retrieval",
    port_id: id,
    contract: RETRIEVAL_CONTRACT,
    contract_minor: RETRIEVAL_CONTRACT_MINOR,
    space: options.space === undefined ? readRetrievalEngineSpace(vaultPath, id) : options.space,
    bound_at: boundAt,
  };
  writeAtomicToml(path, next);
  try {
    if (loadConfiguredRetrieval(vaultPath).id !== id) {
      throw new PortError("config_invalid", "retrieval configuration did not activate", false);
    }
    recordPortState(db, state);
    const stored = readRetrievalPortState(db);
    if (stored?.port_id !== id || stored.bound_at !== boundAt) {
      throw new PortError("unavailable", "retrieval port_state did not activate", true);
    }
    return stored;
  } catch (error) {
    try {
      if (previous === null) unlinkSync(path);
      else writeAtomicToml(path, previous.toString("utf8"));
    } catch {
      // Preserve the activation failure; a leftover file is still a failed persist.
    }
    throw error;
  }
}
