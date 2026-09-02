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

export const SENSITIVITY_ORDER = {
  public: 0,
  personal: 1,
  private: 2,
} as const;
export type Sensitivity = keyof typeof SENSITIVITY_ORDER;

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

/**
 * Everything but `correct`. Relaying the owner's own words files at the top
 * authority tier and retires live claims, so it is granted deliberately or
 * not at all (RFC 0002 §6.4; invariant 8).
 */
export const DEFAULT_GRANT: Grant = {
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
};

export interface Agent {
  agent_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

export type Principal =
  | { kind: "owner"; name: "owner"; grant: Grant }
  | { kind: "agent"; agent: Agent; grant: Grant };

export const OWNER: Principal = {
  kind: "owner",
  name: "owner",
  grant: {
    ceiling: "private",
    types: null,
    subjects: null,
    since: null,
    until: null,
    tools: [...TOOLS],
    rate_limit_per_minute: Number.MAX_SAFE_INTEGER,
    relay_owner_corrections: true,
  },
};

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
}

export interface AuditDenial {
  id: string;
  reason: DenyReason;
}

export interface AuditRow {
  audit_id: string;
  agent_id: string;
  tool: Tool;
  query_shape: Record<string, unknown>;
  served: AuditItem[];
  denied: AuditDenial[];
  at: string;
}
