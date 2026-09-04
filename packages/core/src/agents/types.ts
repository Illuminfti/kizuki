export const TOOLS = [
  "search",
  "get_page",
  "query_entities",
  "timeline",
  "context_packet",
  "graph_neighbors",
  "system_health",
  "propose",
  "correct",
] as const;
export type Tool = (typeof TOOLS)[number];

export const LIFECYCLE_ACTIONS = [
  "agent.create",
  "agent.grant",
  "agent.rotate",
  "agent.revoke",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export const SENSITIVITY_ORDER = {
  public: 0,
  personal: 1,
  private: 2,
} as const;
export type Sensitivity = keyof typeof SENSITIVITY_ORDER;

export function isSensitivity(value: unknown): value is Sensitivity {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, value)
  );
}

/** Ledger schema version that owns agents, grants, and audit. */
export const AGENT_SCHEMA_VERSION = 9;

export const MAX_GRANT_SCOPE_ITEMS = 64;
export const MAX_GRANT_SCOPE_LENGTH = 128;
export const MAX_RATE_LIMIT_PER_MINUTE = 1_000;
export const MAX_AUDIT_PAGE = 100;
export const MAX_AUDIT_ITEMS = 256;

/** Type or subject tokens: `person`, `fact`, `person:ada`. */
export const GRANT_SCOPE_TOKEN =
  /^[a-z][a-z0-9_-]*(?::[A-Za-z0-9._:-]{1,120})?$/;

export interface Grant {
  ceiling: Sensitivity;
  types: string[] | null;
  subjects: string[] | null;
  since: string | null;
  until: string | null;
  tools: Tool[];
  rate_limit_per_minute: number;
  /**
   * RFC 0002 §6.4. When false, a correction this agent relays is filed one
   * tier down: it still outranks connectors and models, but it cannot
   * overturn a correction the owner made directly.
   */
  relay_owner_corrections: boolean;
}

function freezeGrant(grant: Grant): Grant {
  return Object.freeze({
    ceiling: grant.ceiling,
    types: grant.types === null ? null : Object.freeze([...grant.types]),
    subjects:
      grant.subjects === null ? null : Object.freeze([...grant.subjects]),
    since: grant.since,
    until: grant.until,
    tools: Object.freeze([...grant.tools]),
    rate_limit_per_minute: grant.rate_limit_per_minute,
    relay_owner_corrections: grant.relay_owner_corrections,
  }) as Grant;
}

/**
 * Everything but `correct`. Relaying the owner's own words files at the top
 * authority tier and retires live claims, so it is granted deliberately or
 * not at all (RFC 0002 §6.4; invariant 8).
 */
export const DEFAULT_GRANT: Grant = freezeGrant({
  ceiling: "personal",
  types: null,
  subjects: null,
  since: null,
  until: null,
  tools: [
    "search",
    "get_page",
    "query_entities",
    "timeline",
    "context_packet",
    "graph_neighbors",
    "system_health",
    "propose",
  ],
  rate_limit_per_minute: 60,
  relay_owner_corrections: true,
});

/** Harnesses the owner runs themselves (RFC 0002 §8.4). */
export const OWNER_AGENT_GRANT: Grant = freezeGrant({
  ...DEFAULT_GRANT,
  ceiling: "private",
  tools: [...DEFAULT_GRANT.tools],
});

export interface Agent {
  agent_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

export type Principal =
  | { kind: "owner"; name: "owner"; grant: Grant }
  | { kind: "agent"; agent: Agent; grant: Grant; grant_epoch: number };

export const OWNER: Principal = Object.freeze({
  kind: "owner",
  name: "owner",
  grant: freezeGrant({
    ceiling: "private",
    types: null,
    subjects: null,
    since: null,
    until: null,
    tools: [...TOOLS],
    rate_limit_per_minute: 60,
    relay_owner_corrections: true,
  }),
});

export type DenyReason =
  | "missing_sensitivity"
  /** RFC 0002 §10.5: a page with no taint stamp is capture until proven otherwise. */
  | "missing_taint"
  | "above_ceiling"
  | "type_out_of_scope"
  | "subject_out_of_scope"
  | "time_out_of_scope"
  | "tool_not_granted"
  | "unknown_agent"
  | "rate_limited"
  | "held"
  /** A call refused before any data was read. */
  | "invalid_arguments"
  /** The engine failed; the cause never leaves core. */
  | "error";

export interface Servable {
  id: string;
  sensitivity: string | null | undefined;
  type?: string;
  subjects?: string[];
  occurred_at?: string;
  held?: boolean;
}

export interface AuditItem {
  id: string;
  sensitivity: string;
  taint?: string | null;
  authority?: string | null;
  provenance_count?: number;
}

export interface AuditDenial {
  id: string;
  reason: DenyReason;
}

export interface AuditRow {
  audit_id: string;
  agent_id: string;
  tool: Tool | LifecycleAction;
  query_shape: Record<string, unknown>;
  served: AuditItem[];
  denied: AuditDenial[];
  at: string;
  grant_epoch: number | null;
}

export interface AuditPage {
  rows: AuditRow[];
  next_cursor: string | null;
}

export interface AgentFinding {
  agent_id: string;
  name: string;
  reason: "invalid_grant";
  quarantined_at: string;
}
