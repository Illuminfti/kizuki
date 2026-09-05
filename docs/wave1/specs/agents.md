> **Superseded owner-gate framing, 2026-09-02.** Propose-only writes are
> incomplete. RFC 0002 adds MCP `correct`. Reissue `TOOLS` against
> `rfcs/0002-autonomous-canon.md`.

# Lane: agents — identity, grants, audit, enforcement

## Decision-log deltas (2026-09-02)

- The read-first framing "read grants with a sensitivity ceiling,
  propose-only writes, rate limits and audit" is superseded. Serving exposes
  two write tools, `propose` and `correct` (D14, RFC 0002 §6.1). `TOOLS` in
  this spec already lists both; the surrounding prose must not describe the
  write authority as proposal-only.
- `correct` is owner-tier by default, because a harness relaying the owner's
  sentence is the owner speaking. Three protections make that safe and are
  part of this lane: a tool call is never reachable from captured text, the
  receipt records `relayed_by`, and `Grant.tools` may exclude `correct` or
  set `relay_owner_corrections: false` to downgrade the tier to
  `owner_authored` (RFC 0002 §6.4).
- **Superseded by D18 (2026-09-05):** arbitrary enrollment defaults to
  `ceiling: "public"`, empty tools/types/subjects, null time bounds, 60/minute
  and `relay_owner_corrections: false`. Empty arrays deny; explicit `null`
  selects unscoped access. `OWNER_AGENT_GRANT` is the separate literal private
  preset chosen explicitly by a trusted caller; `addAgent` never selects it
  by omission. Existing stored grants and the built-in `OWNER` are unchanged.
  See RFC 0002 §8.4; this spec does not prescribe a CLI preset flag.
- Sensitivity is never owner-labeled (D11). Enforcement order is unchanged
  and stays below the prompt layer: `held`, then `missing_sensitivity`, then
  `above_ceiling`, then type, subject and time. A ceiling filter fails
  closed: a scope that yields nothing returns nothing, and widening it
  because the narrow scope was empty is a security bug (RFC 0002 §8.4, §9.2).

Package: `packages/core` only, new directory `src/agents/`. Read
CONVENTIONS.md first. Do NOT edit `ledger/`, `staging/`, `vault/`,
`search/` (sibling lanes). Do NOT wire any CLI verb or MCP server.

## Objective

Architecture §8.1: agents are first-class consumers with identity, scoped
read grants with a sensitivity ceiling, `propose` and `correct` writes, rate limits and
a full audit trail — enforced below the prompt layer by pure functions the
serving lanes call.

## 1. Schema (`initAgents(db)`, idempotent)

```sql
CREATE TABLE IF NOT EXISTS agents (
  agent_id   TEXT PRIMARY KEY,      -- ULID
  name       TEXT NOT NULL UNIQUE,  -- [a-z0-9][a-z0-9-]{1,63}
  token_hash TEXT NOT NULL UNIQUE,  -- sha256 hex of the token; token itself never stored
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS agent_grants (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(agent_id),
  ceiling    TEXT NOT NULL,         -- public | personal | private
  types      TEXT,                  -- JSON array of page types or NULL = all
  subjects   TEXT,                  -- JSON array of subject ids or NULL = all
  since      TEXT, until TEXT,      -- RFC3339 bounds on occurred_at for ledger-derived data, NULL = unbounded
  tools      TEXT NOT NULL,         -- JSON array of tool names
  rate_limit_per_minute INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agent_audit (
  audit_id     TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  query_shape  TEXT NOT NULL,       -- JSON: the arguments with free text replaced by { len, sha256 } — never the raw text
  served       TEXT NOT NULL,       -- JSON array of { id, sensitivity }
  denied       TEXT NOT NULL,       -- JSON array of { id, reason }
  at           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_audit_by_agent ON agent_audit(agent_id, at);
```

## 2. API (`src/agents/`)

```ts
export const TOOLS = ['search','get_page','query_entities','timeline','context_packet','graph_neighbors','system_health','propose','correct'] as const
export type Tool = typeof TOOLS[number]
export const SENSITIVITY_ORDER = { public: 0, personal: 1, private: 2 } as const
export interface Grant { ceiling: Sensitivity; types: string[] | null; subjects: string[] | null; since: string | null; until: string | null; tools: Tool[]; rate_limit_per_minute: number; relay_owner_corrections: boolean }
export const DEFAULT_GRANT: Grant   // ceiling 'public', tools/types/subjects [], since/until null, 60/min, relay false
export const OWNER_AGENT_GRANT: Grant // explicit literal private preset; tools ['search','get_page','query_entities','timeline','context_packet','graph_neighbors','system_health','propose']; types/subjects/since/until null, 60/min, relay false
export const OWNER: Principal       // { kind:'owner', name:'owner', grant: { ceiling:'private', ... unlimited } } — never persisted
export interface Agent { agent_id; name; created_at; revoked_at: string | null }
export type Principal = { kind: 'owner'; name: 'owner'; grant: Grant } | { kind: 'agent'; agent: Agent; grant: Grant }

export function addAgent(db, name, grant?: Partial<Grant>): { agent: Agent; token: string }
   // omitted grant uses DEFAULT_GRANT; the owner preset requires an explicit argument
   // token = 'kzk_' + 32 bytes crypto.getRandomValues base32 (Crockford); shown once; store sha256
export function authenticate(db, token): Principal | null     // null for unknown, revoked, or malformed; constant-time compare on the hash
export function getAgent(db, name): Agent | null
export function listAgents(db): (Agent & { grant: Grant })[]
export function setGrant(db, name, patch: Partial<Grant>): Grant   // validates: ceiling enum; tools ⊆ TOOLS; rate ≥ 1; since/until RFC3339 and since ≤ until
export function revokeAgent(db, name): void                       // sets revoked_at; authenticate returns null afterwards
export function rotateToken(db, name): string

export type DenyReason = 'missing_sensitivity' | 'above_ceiling' | 'type_out_of_scope' | 'subject_out_of_scope' | 'time_out_of_scope' | 'tool_not_granted' | 'unknown_agent' | 'rate_limited' | 'held'
export interface Servable { id: string; sensitivity: string | null | undefined; type?: string; subjects?: string[]; occurred_at?: string; held?: boolean }
export function authorize(grant: Grant, item: Servable): { allow: true } | { allow: false; reason: DenyReason }
   // pure; order of checks: held → missing_sensitivity (null/undefined/'unlabeled'/unknown string) → above_ceiling → type → subject (allow if ANY item subject ∈ grant.subjects; deny if item has no subjects and grant restricts subjects) → time
export function filterServable<T extends Servable>(grant, items: T[]): { served: T[]; denied: { id; reason }[] }
export function toolAllowed(grant, tool): boolean
export function checkRate(db, principal, tool, now?: string): { allow: true } | { allow: false; reason: 'rate_limited'; retry_after_seconds: number }
   // owner always allowed; agents: count agent_audit rows in the last 60s
export function recordAudit(db, principal, tool, args: Record<string, unknown>, served: {id; sensitivity}[], denied: {id; reason}[]): string   // owner calls are recorded too, agent_id 'owner'
export function listAudit(db, name | 'owner', opts?: { limit?: number; since?: string }): AuditRow[]
export function shapeArguments(args): Record<string, unknown>  // exported for tests: strings ≥ 1 char → { len, sha256 }; numbers/booleans/arrays of ≤ 8 short ids kept; nested objects recursed
```

## 3. Tests (`test/agents/`)

- addAgent returns a token starting `kzk_` that authenticates once stored;
  the token never appears in the database file (read the raw db bytes via
  `readFileSync` after `db.close()` and assert the token substring is absent).
- name validation (rejects uppercase, spaces, 65 chars, duplicates).
- revoke → authenticate null; rotate → old token null, new token works.
- `authorize` truth table: every DenyReason has at least one test; the
  ordering of checks is asserted (an unlabeled private-scope item reports
  `missing_sensitivity`, not `above_ceiling`).
- **Grant-ceiling test** (the Wave 2 exit proof): a `private` item is denied
  to a `personal`-ceiling grant, allowed to `private`; an unlabeled item is
  denied to every grant, including `private`; the OWNER principal is also
  denied unlabeled items (fail closed applies to everyone).
- rate limit: 3 calls with limit 3 allowed, 4th denied with retry_after > 0;
  owner unlimited.
- audit: query_shape never contains the raw query text (assert the sha256
  of the text is present and the text is not); served/denied round-trip;
  listAudit ordering and limit.
- foreign key: grant for a nonexistent agent is refused.

## 4. Exports

`packages/core/src/index.ts` exports everything above.

## Acceptance

```
bun run typecheck
bun test                    # green; ≥ 25 new tests
scripts/verify.sh must stay green (denylist produces no output)
git status --porcelain      # empty
```
