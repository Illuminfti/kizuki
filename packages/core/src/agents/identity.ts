import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { ulid } from "../util/ulid";
import { rfc3339Millis } from "./time";
import {
  DEFAULT_GRANT,
  SENSITIVITY_ORDER,
  TOOLS,
} from "./types";
import type { Agent, Grant, Principal, Tool } from "./types";

const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOKEN_PREFIX = "kzk_";
const TOKEN_BODY = /^[0-9A-HJKMNP-TV-Z]{52}$/;
const TOKEN_BYTES = 32;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface AgentRow {
  agent_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

interface AgentGrantRow extends AgentRow {
  token_hash: string;
  ceiling: string;
  types: string | null;
  subjects: string | null;
  since: string | null;
  until: string | null;
  tools: string;
  rate_limit_per_minute: number;
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function encodeCrockford(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += CROCKFORD[(buffer >> bitCount) & 31];
      buffer &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) {
    output += CROCKFORD[(buffer << (5 - bitCount)) & 31];
  }
  return output;
}

function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${encodeCrockford(bytes)}`;
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBytes = new Uint8Array(TOKEN_BYTES);
  const rightBytes = new Uint8Array(TOKEN_BYTES);
  const leftValid = SHA256_HEX.test(left);
  const rightValid = SHA256_HEX.test(right);
  if (leftValid) leftBytes.set(Buffer.from(left, "hex"));
  if (rightValid) rightBytes.set(Buffer.from(right, "hex"));
  return timingSafeEqual(leftBytes, rightBytes) && leftValid && rightValid;
}

function parseStringArray(raw: string | null, field: string): string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${field}: stored value is not a string array`);
  }
  return parsed;
}

function validateScope(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new TypeError(`${field}: must be null or an array of non-empty strings`);
  }
  return [...value];
}

function validateGrant(grant: Grant): Grant {
  if (!Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, grant.ceiling)) {
    throw new TypeError("ceiling: must be public, personal, or private");
  }
  const types = validateScope(grant.types, "types");
  const subjects = validateScope(grant.subjects, "subjects");
  if (
    !Array.isArray(grant.tools) ||
    !grant.tools.every(
      (tool) => typeof tool === "string" && (TOOLS as readonly string[]).includes(tool),
    )
  ) {
    throw new TypeError(`tools: every entry must be one of ${TOOLS.join(" | ")}`);
  }
  if (
    !Number.isInteger(grant.rate_limit_per_minute) ||
    grant.rate_limit_per_minute < 1
  ) {
    throw new TypeError("rate_limit_per_minute: must be an integer of at least 1");
  }
  for (const [field, value] of [
    ["since", grant.since],
    ["until", grant.until],
  ] as const) {
    if (value !== null) rfc3339Millis(value, field);
  }
  if (
    grant.since !== null &&
    grant.until !== null &&
    rfc3339Millis(grant.since, "since") > rfc3339Millis(grant.until, "until")
  ) {
    throw new TypeError("since: must not be after until");
  }
  return {
    ceiling: grant.ceiling,
    types,
    subjects,
    since: grant.since,
    until: grant.until,
    tools: [...grant.tools],
    rate_limit_per_minute: grant.rate_limit_per_minute,
  };
}

function mergeGrant(base: Grant, patch: Partial<Grant>): Grant {
  return validateGrant({ ...base, ...patch });
}

function rowAgent(row: AgentRow): Agent {
  return {
    agent_id: row.agent_id,
    name: row.name,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function rowGrant(row: AgentGrantRow): Grant {
  const tools = parseStringArray(row.tools, "tools");
  if (tools === null) throw new Error("tools: stored value cannot be null");
  return validateGrant({
    ceiling: row.ceiling as Grant["ceiling"],
    types: parseStringArray(row.types, "types"),
    subjects: parseStringArray(row.subjects, "subjects"),
    since: row.since,
    until: row.until,
    tools: tools as Tool[],
    rate_limit_per_minute: row.rate_limit_per_minute,
  });
}

function grantRowByName(db: Database, name: string): AgentGrantRow | null {
  return db
    .query<AgentGrantRow, [string]>(
      `SELECT a.agent_id, a.name, a.token_hash, a.created_at, a.revoked_at,
              g.ceiling, g.types, g.subjects, g.since, g.until, g.tools,
              g.rate_limit_per_minute
         FROM agents a
         JOIN agent_grants g ON g.agent_id = a.agent_id
        WHERE a.name = ?`,
    )
    .get(name);
}

function writeGrant(db: Database, agentId: string, grant: Grant, at: string): void {
  db.query<
    never,
    [string, string, string | null, string | null, string | null, string | null, string, number, string]
  >(
    `INSERT INTO agent_grants
       (agent_id, ceiling, types, subjects, since, until, tools,
        rate_limit_per_minute, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    grant.ceiling,
    grant.types === null ? null : JSON.stringify(grant.types),
    grant.subjects === null ? null : JSON.stringify(grant.subjects),
    grant.since,
    grant.until,
    JSON.stringify(grant.tools),
    grant.rate_limit_per_minute,
    at,
  );
}

export function addAgent(
  db: Database,
  name: string,
  grantPatch: Partial<Grant> = {},
): { agent: Agent; token: string } {
  if (!NAME.test(name)) {
    throw new TypeError("name: must match [a-z0-9][a-z0-9-]{1,63}");
  }
  const grant = mergeGrant(DEFAULT_GRANT, grantPatch);
  const token = generateToken();
  const tokenHash = hashToken(token);
  const agent: Agent = {
    agent_id: ulid(),
    name,
    created_at: new Date().toISOString(),
    revoked_at: null,
  };

  db.transaction(() => {
    if (getAgent(db, name) !== null) {
      throw new Error(`agent ${name} already exists`);
    }
    db.query<never, [string, string, string, string]>(
      `INSERT INTO agents (agent_id, name, token_hash, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(agent.agent_id, agent.name, tokenHash, agent.created_at);
    writeGrant(db, agent.agent_id, grant, agent.created_at);
  }).immediate();

  return { agent, token };
}

export function authenticate(db: Database, token: string): Principal | null {
  if (
    typeof token !== "string" ||
    !token.startsWith(TOKEN_PREFIX) ||
    !TOKEN_BODY.test(token.slice(TOKEN_PREFIX.length))
  ) {
    return null;
  }
  const candidateHash = hashToken(token);
  const rows = db
    .query<AgentGrantRow, []>(
      `SELECT a.agent_id, a.name, a.token_hash, a.created_at, a.revoked_at,
              g.ceiling, g.types, g.subjects, g.since, g.until, g.tools,
              g.rate_limit_per_minute
         FROM agents a
         JOIN agent_grants g ON g.agent_id = a.agent_id
        ORDER BY a.agent_id`,
    )
    .all();
  let match: AgentGrantRow | null = null;
  for (const row of rows) {
    if (constantTimeHashEqual(row.token_hash, candidateHash)) match = row;
  }
  if (match === null || match.revoked_at !== null) return null;
  return { kind: "agent", agent: rowAgent(match), grant: rowGrant(match) };
}

export function getAgent(db: Database, name: string): Agent | null {
  const row = db
    .query<AgentRow, [string]>(
      "SELECT agent_id, name, created_at, revoked_at FROM agents WHERE name = ?",
    )
    .get(name);
  return row === null ? null : rowAgent(row);
}

export function listAgents(db: Database): (Agent & { grant: Grant })[] {
  return db
    .query<AgentGrantRow, []>(
      `SELECT a.agent_id, a.name, a.token_hash, a.created_at, a.revoked_at,
              g.ceiling, g.types, g.subjects, g.since, g.until, g.tools,
              g.rate_limit_per_minute
         FROM agents a
         JOIN agent_grants g ON g.agent_id = a.agent_id
        ORDER BY a.name`,
    )
    .all()
    .map((row) => ({ ...rowAgent(row), grant: rowGrant(row) }));
}

export function setGrant(
  db: Database,
  name: string,
  patch: Partial<Grant>,
): Grant {
  return db.transaction((): Grant => {
    const row = grantRowByName(db, name);
    if (row === null) throw new Error(`agent ${name} does not exist`);
    const grant = mergeGrant(rowGrant(row), patch);
    db.query<
      never,
      [string, string | null, string | null, string | null, string | null, string, number, string, string]
    >(
      `UPDATE agent_grants
          SET ceiling = ?, types = ?, subjects = ?, since = ?, until = ?,
              tools = ?, rate_limit_per_minute = ?, updated_at = ?
        WHERE agent_id = ?`,
    ).run(
      grant.ceiling,
      grant.types === null ? null : JSON.stringify(grant.types),
      grant.subjects === null ? null : JSON.stringify(grant.subjects),
      grant.since,
      grant.until,
      JSON.stringify(grant.tools),
      grant.rate_limit_per_minute,
      new Date().toISOString(),
      row.agent_id,
    );
    return grant;
  }).immediate();
}

export function revokeAgent(db: Database, name: string): void {
  const result = db.query<never, [string, string]>(
    "UPDATE agents SET revoked_at = coalesce(revoked_at, ?) WHERE name = ?",
  ).run(new Date().toISOString(), name);
  if (result.changes === 0) throw new Error(`agent ${name} does not exist`);
}

export function rotateToken(db: Database, name: string): string {
  const agent = getAgent(db, name);
  if (agent === null) throw new Error(`agent ${name} does not exist`);
  if (agent.revoked_at !== null) throw new Error(`agent ${name} is revoked`);
  const token = generateToken();
  db.query<never, [string, string]>(
    "UPDATE agents SET token_hash = ? WHERE agent_id = ?",
  ).run(hashToken(token), agent.agent_id);
  return token;
}
