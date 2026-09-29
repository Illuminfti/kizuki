import path from "node:path";
import { KizukiError, isPlainObject } from "@kizuki/core";

export const CLAUDE_CODE_SESSIONS_CONNECTOR_ID = "kizuki.claude-code-sessions" as const;
export const CODEX_SESSIONS_CONNECTOR_ID = "kizuki.codex-sessions" as const;

export type SessionFlavor = "claude-code" | "codex";
export type SessionsConnectorId =
  | typeof CLAUDE_CODE_SESSIONS_CONNECTOR_ID
  | typeof CODEX_SESSIONS_CONNECTOR_ID;

export interface AgentSessionsConfig {
  /** Directory holding the transcripts, such as the harness's projects or sessions folder. */
  path: string;
  /** Also read subagent transcripts. Default false. */
  include_subagents?: boolean;
  /** Absolute directories whose sessions are never captured, such as the vault. */
  exclude_cwd?: readonly string[];
}

export interface ParsedAgentSessionsConfig {
  path: string;
  include_subagents: boolean;
  exclude_cwd: readonly string[];
}

const KEYS = new Set(["path", "include_subagents", "exclude_cwd"]);

export function parseConfig(id: SessionsConnectorId, config: unknown): ParsedAgentSessionsConfig {
  const fail = (detail: string): never => {
    throw new KizukiError("misconfigured", `${id}: ${detail}`);
  };
  if (!isPlainObject(config)) return fail("config must be an object");
  if (Object.keys(config).some((key) => !KEYS.has(key))) return fail("config contains an unknown key");
  const configured = config["path"];
  if (typeof configured !== "string" || configured.length === 0) return fail("config.path must be a non-empty string");
  const subagents = config["include_subagents"];
  if (subagents !== undefined && typeof subagents !== "boolean") return fail("config.include_subagents must be a boolean");
  const excluded = config["exclude_cwd"];
  if (
    excluded !== undefined &&
    (!Array.isArray(excluded) || excluded.length > 64 ||
      !excluded.every((entry) => typeof entry === "string" && path.isAbsolute(entry)))
  ) {
    return fail("config.exclude_cwd must be at most 64 absolute paths");
  }
  return {
    path: path.resolve(configured),
    include_subagents: subagents === true,
    exclude_cwd: ((excluded ?? []) as string[]).map((entry) => path.resolve(entry)),
  };
}
