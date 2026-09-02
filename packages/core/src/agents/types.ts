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
}

export const DEFAULT_GRANT: Grant = {
  ceiling: "personal",
  types: null,
  subjects: null,
  since: null,
  until: null,
  tools: [...TOOLS],
  rate_limit_per_minute: 60,
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
  },
};

export type DenyReason =
  | "missing_sensitivity"
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
