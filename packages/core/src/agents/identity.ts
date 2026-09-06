import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { ulid } from "../util/ulid";
import { recordLifecycle } from "./audit";
import { sha256 } from "./hash";
import { compareRfc3339, rfc3339Millis } from "./time";
import {
  DEFAULT_GRANT,
  GRANT_SCOPE_TOKEN,
  MAX_GRANT_SCOPE_ITEMS,
  MAX_GRANT_SCOPE_LENGTH,
  MAX_RATE_LIMIT_PER_MINUTE,
  SENSITIVITY_ORDER,
  TOOLS,
} from "./types";
import type {
  Agent,
  AgentFinding,
  Grant,
  Principal,
  Tool,
} from "./types";

export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOKEN_PREFIX = "kzk_";
const TOKEN_BODY = /^[0-9A-HJKMNP-TV-Z]{52}$/;
const TOKEN_BYTES = 32;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHA256_HEX = /^[0-9a-f]{64}$/;

const AGENT_GRANT_SELECT = `
  SELECT a.agent_id, a.name, a.token_hash, a.created_at, a.revoked_at,
         a.quarantined_at, g.ceiling, g.types, g.subjects, g.since, g.until,
         g.tools, g.rate_limit_per_minute, g.relay_owner_corrections,
         g.grant_epoch
    FROM agents a
    JOIN agent_grants g ON g.agent_id = a.agent_id
`;

interface AgentRow {
  agent_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

interface AgentGrantRow extends AgentRow {
  token_hash: string;
  quarantined_at: string | null;
  ceiling: string;
  types: string | null;
  subjects: string | null;
  since: string | null;
  until: string | null;
  tools: string;
  rate_limit_per_minute: number;
  relay_owner_corrections: number;
  grant_epoch: number;
}

export function hashAgentToken(token: string): string {
  return sha256(token);
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

export function generateAgentToken(): string {
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
  if (!Array.isArray(value)) {
    throw new TypeError(`${field}: must be null or an array of non-empty strings`);
  }
  if (value.length > MAX_GRANT_SCOPE_ITEMS) {
    throw new TypeError(
      `${field}: must contain at most ${MAX_GRANT_SCOPE_ITEMS} entries`,
    );
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${field}: must be null or an array of non-empty strings`);
    }
    if (entry.length > MAX_GRANT_SCOPE_LENGTH || !GRANT_SCOPE_TOKEN.test(entry)) {
      throw new TypeError(`${field}: contains an invalid scope token`);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }
  return unique;
}

export function validateAgentGrant(grant: Grant): Grant {
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
    !Number.isSafeInteger(grant.rate_limit_per_minute) ||
    grant.rate_limit_per_minute < 1 ||
    grant.rate_limit_per_minute > MAX_RATE_LIMIT_PER_MINUTE
  ) {
    throw new TypeError(
      `rate_limit_per_minute: must be an integer from 1 to ${MAX_RATE_LIMIT_PER_MINUTE}`,
    );
  }
  if (typeof grant.relay_owner_corrections !== "boolean") {
    throw new TypeError("relay_owner_corrections: must be a boolean");
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
    compareRfc3339(grant.since, "since", grant.until, "until") > 0
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
    relay_owner_corrections: grant.relay_owner_corrections,
  };
}

function mergeGrant(base: Grant, patch: Partial<Grant>): Grant {
  return validateAgentGrant({ ...base, ...patch });
}

function rowAgent(row: AgentRow): Agent {
  return {
    agent_id: row.agent_id,
    name: row.name,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function decodeGrant(row: AgentGrantRow): Grant {
  const tools = parseStringArray(row.tools, "tools");
  if (tools === null) throw new Error("tools: stored value cannot be null");
  if (!Number.isSafeInteger(row.rate_limit_per_minute)) {
    throw new TypeError("rate_limit_per_minute: stored value is not a safe integer");
  }
  return validateAgentGrant({
    ceiling: row.ceiling as Grant["ceiling"],
    types: parseStringArray(row.types, "types"),
    subjects: parseStringArray(row.subjects, "subjects"),
    since: row.since,
    until: row.until,
    tools: tools as Tool[],
    rate_limit_per_minute: row.rate_limit_per_minute,
    relay_owner_corrections: row.relay_owner_corrections !== 0,
  });
}

function tryDecodeGrant(row: AgentGrantRow): Grant | null {
  try {
    return decodeGrant(row);
  } catch {
    return null;
  }
}

function tryRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Fields that still decode are kept. Fields that do not become the closed
 * value — public, empty scopes, no tools, rate 1, no relay — never the
 * default new-agent grant, which would widen a locked-down row.
 */
function repairBase(row: AgentGrantRow): Grant {
  const types = tryRead(() =>
    validateScope(parseStringArray(row.types, "types"), "types"),
  );
  const subjects = tryRead(() =>
    validateScope(parseStringArray(row.subjects, "subjects"), "subjects"),
  );
  const tools = tryRead(() => {
    const parsed = parseStringArray(row.tools, "tools");
    if (
      parsed === null ||
      !parsed.every((tool) => (TOOLS as readonly string[]).includes(tool))
    ) {
      throw new TypeError("tools");
    }
    return parsed as Tool[];
  });
  const since = tryRead(() => {
    if (row.since !== null) rfc3339Millis(row.since, "since");
    return row.since;
  });
  const until = tryRead(() => {
    if (row.until !== null) rfc3339Millis(row.until, "until");
    return row.until;
  });
  return {
    ceiling: Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, row.ceiling)
      ? (row.ceiling as Grant["ceiling"])
      : "public",
    types: types !== undefined ? types : [],
    subjects: subjects !== undefined ? subjects : [],
    since: since !== undefined ? since : null,
    until: until !== undefined ? until : null,
    tools: tools ?? [],
    rate_limit_per_minute:
      Number.isSafeInteger(row.rate_limit_per_minute) &&
      row.rate_limit_per_minute >= 1 &&
      row.rate_limit_per_minute <= MAX_RATE_LIMIT_PER_MINUTE
        ? row.rate_limit_per_minute
        : 1,
    relay_owner_corrections: row.relay_owner_corrections === 1,
  };
}

function grantEpoch(row: AgentGrantRow): number {
  return Number.isSafeInteger(row.grant_epoch) && row.grant_epoch >= 1
    ? row.grant_epoch
    : 1;
}

function principalFromRow(row: AgentGrantRow): Principal | null {
  if (row.revoked_at !== null || row.quarantined_at !== null) return null;
  const grant = tryDecodeGrant(row);
  if (grant === null) return null;
  return {
    kind: "agent",
    agent: rowAgent(row),
    grant,
    grant_epoch: grantEpoch(row),
  };
}

function grantRowByName(db: Database, name: string): AgentGrantRow | null {
  return db
    .query<AgentGrantRow, [string]>(`${AGENT_GRANT_SELECT} WHERE a.name = ?`)
    .get(name);
}

function grantRowById(db: Database, agentId: string): AgentGrantRow | null {
  return db
    .query<AgentGrantRow, [string]>(`${AGENT_GRANT_SELECT} WHERE a.agent_id = ?`)
    .get(agentId);
}

function quarantineIfInvalid(db: Database, agentId: string, at: string): void {
  db.transaction(() => {
    const row = grantRowById(db, agentId);
    if (row === null || row.revoked_at !== null || row.quarantined_at !== null) {
      return;
    }
    if (tryDecodeGrant(row) !== null) return;
    db.query<never, [string, string, string]>(
      `UPDATE agents
          SET quarantined_at = coalesce(quarantined_at, ?),
              quarantine_reason = coalesce(quarantine_reason, ?)
        WHERE agent_id = ? AND quarantined_at IS NULL`,
    ).run(at, "invalid_grant", agentId);
  }).immediate();
}

export function writeAgentGrant(
  db: Database,
  agentId: string,
  grant: Grant,
  at: string,
  epoch: number,
): void {
  db.query<
    never,
    [string, string, string | null, string | null, string | null, string | null, string, number, number, number, string]
  >(
    `INSERT INTO agent_grants
       (agent_id, ceiling, types, subjects, since, until, tools,
        rate_limit_per_minute, relay_owner_corrections, grant_epoch, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    grant.ceiling,
    grant.types === null ? null : JSON.stringify(grant.types),
    grant.subjects === null ? null : JSON.stringify(grant.subjects),
    grant.since,
    grant.until,
    JSON.stringify(grant.tools),
    grant.rate_limit_per_minute,
    grant.relay_owner_corrections ? 1 : 0,
    epoch,
    at,
  );
}

export function addAgent(
  db: Database,
  name: string,
  grantPatch: Partial<Grant> = {},
): { agent: Agent; token: string } {
  if (!AGENT_NAME.test(name)) {
    throw new TypeError("name: must match [a-z0-9][a-z0-9-]{1,63}");
  }
  if (name === "owner") {
    throw new TypeError("name: owner is reserved for the owner principal");
  }
  const grant = mergeGrant(DEFAULT_GRANT, grantPatch);
  const token = generateAgentToken();
  const tokenHash = hashAgentToken(token);
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
    writeAgentGrant(db, agent.agent_id, grant, agent.created_at, 1);
    recordLifecycle(db, agent.agent_id, "agent.create", {
      after: grant,
    }, agent.created_at);
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
  const candidateHash = hashAgentToken(token);
  const rows = db
    .query<AgentGrantRow, []>(`${AGENT_GRANT_SELECT} ORDER BY a.agent_id`)
    .all();
  let match: AgentGrantRow | null = null;
  for (const row of rows) {
    if (constantTimeHashEqual(row.token_hash, candidateHash)) match = row;
  }
  if (match === null) return null;
  const principal = principalFromRow(match);
  if (principal !== null) return principal;
  if (match.revoked_at === null && match.quarantined_at === null) {
    quarantineIfInvalid(db, match.agent_id, new Date().toISOString());
  }
  return null;
}

/**
 * Reload the grant the store currently holds. A retained Principal is only
 * an identity handle; this is the per-call authority read.
 */
export function resolvePrincipal(
  db: Database,
  principal: Principal,
): Principal | null {
  if (principal.kind === "owner") return principal;
  const row = grantRowById(db, principal.agent.agent_id);
  if (row === null) return null;
  const resolved = principalFromRow(row);
  if (resolved !== null) return resolved;
  if (row.revoked_at === null && row.quarantined_at === null) {
    quarantineIfInvalid(db, row.agent_id, new Date().toISOString());
  }
  return null;
}

/** Internal shared reader for enrollment receipts; it never treats a receipt as authority. */
export function principalForAgentId(db: Database, agentId: string): Principal | null {
  const row = grantRowById(db, agentId);
  if (row === null) return null;
  return principalFromRow(row);
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
  const listed: (Agent & { grant: Grant })[] = [];
  for (const row of db
    .query<AgentGrantRow, []>(`${AGENT_GRANT_SELECT} ORDER BY a.name`)
    .all()) {
    const grant = tryDecodeGrant(row);
    if (grant === null) {
      if (row.quarantined_at === null) {
        quarantineIfInvalid(db, row.agent_id, new Date().toISOString());
      }
      continue;
    }
    listed.push({ ...rowAgent(row), grant });
  }
  return listed;
}

export function listQuarantinedAgents(db: Database): AgentFinding[] {
  return db
    .query<
      { agent_id: string; name: string; quarantined_at: string },
      []
    >(
      `SELECT agent_id, name, quarantined_at FROM agents
        WHERE quarantined_at IS NOT NULL
        ORDER BY name`,
    )
    .all()
    .map((row) => ({
      agent_id: row.agent_id,
      name: row.name,
      reason: "invalid_grant" as const,
      quarantined_at: row.quarantined_at,
    }));
}

/** Census of every stored identity, including rows `listAgents` skips. */
export function countAgents(db: Database): {
  total: number;
  revoked: number;
  quarantined: number;
} {
  listAgents(db);
  const row = db
    .query<{ total: number; revoked: number; quarantined: number }, []>(
      `SELECT count(*) AS total,
              count(revoked_at) AS revoked,
              count(quarantined_at) AS quarantined
         FROM agents`,
    )
    .get();
  return {
    total: row?.total ?? 0,
    revoked: row?.revoked ?? 0,
    quarantined: row?.quarantined ?? 0,
  };
}

export function setGrant(
  db: Database,
  name: string,
  patch: Partial<Grant>,
): Grant {
  return db.transaction((): Grant => {
    const row = grantRowByName(db, name);
    if (row === null) throw new Error(`agent ${name} does not exist`);
    const before = tryDecodeGrant(row);
    const grant = mergeGrant(before ?? repairBase(row), patch);
    const at = new Date().toISOString();
    const epoch = grantEpoch(row) + 1;
    db.query<
      never,
      [string, string | null, string | null, string | null, string | null, string, number, number, number, string, string]
    >(
      `UPDATE agent_grants
          SET ceiling = ?, types = ?, subjects = ?, since = ?, until = ?,
              tools = ?, rate_limit_per_minute = ?,
              relay_owner_corrections = ?, grant_epoch = ?, updated_at = ?
        WHERE agent_id = ?`,
    ).run(
      grant.ceiling,
      grant.types === null ? null : JSON.stringify(grant.types),
      grant.subjects === null ? null : JSON.stringify(grant.subjects),
      grant.since,
      grant.until,
      JSON.stringify(grant.tools),
      grant.rate_limit_per_minute,
      grant.relay_owner_corrections ? 1 : 0,
      epoch,
      at,
      row.agent_id,
    );
    db.query<never, [string]>(
      `UPDATE agents
          SET quarantined_at = NULL, quarantine_reason = NULL
        WHERE agent_id = ?`,
    ).run(row.agent_id);
    recordLifecycle(
      db,
      row.agent_id,
      "agent.grant",
      before === null ? { after: grant } : { before, after: grant },
      at,
    );
    return grant;
  }).immediate();
}

export function revokeAgentInTransaction(db: Database, name: string): void {
  const row = grantRowByName(db, name);
  if (row === null) throw new Error(`agent ${name} does not exist`);
  const at = new Date().toISOString();
  if (row.revoked_at === null) {
    db.query<never, [string, string]>(
      "UPDATE agents SET revoked_at = ? WHERE name = ?",
    ).run(at, name);
    db.query<never, [number, string, string]>(
      `UPDATE agent_grants
          SET grant_epoch = ?, updated_at = ?
        WHERE agent_id = ?`,
    ).run(grantEpoch(row) + 1, at, row.agent_id);
    const before = tryDecodeGrant(row);
    recordLifecycle(
      db,
      row.agent_id,
      "agent.revoke",
      before === null ? {} : { before },
      at,
    );
  }
}

export function revokeAgent(db: Database, name: string): void {
  db.transaction(() => {
    revokeAgentInTransaction(db, name);
  }).immediate();
}

export function rotateToken(db: Database, name: string): string {
  return db.transaction((): string => {
    const row = grantRowByName(db, name);
    if (row === null) throw new Error(`agent ${name} does not exist`);
    if (row.revoked_at !== null) throw new Error(`agent ${name} is revoked`);
    const token = generateAgentToken();
    const at = new Date().toISOString();
    db.query<never, [string, string]>(
      "UPDATE agents SET token_hash = ? WHERE agent_id = ?",
    ).run(hashAgentToken(token), row.agent_id);
    db.query<never, [number, string, string]>(
      `UPDATE agent_grants
          SET grant_epoch = ?, updated_at = ?
        WHERE agent_id = ?`,
    ).run(grantEpoch(row) + 1, at, row.agent_id);
    recordLifecycle(db, row.agent_id, "agent.rotate", {}, at);
    return token;
  }).immediate();
}
