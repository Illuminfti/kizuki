import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enrollAppAgent, revokeAgentEnrollment, type AppAgentEnrollmentRequest, type AgentEnrollmentResult } from "@kizuki/core";
import { IS_COMPILED } from "../runtime";

export interface AppAgentMcpConfiguration { command: string; args: string[]; }
export interface AppAgentSetup {
  receipt: AgentEnrollmentResult;
  mcp: AppAgentMcpConfiguration | null;
}
export class AppAgentSetupError extends Error {
  readonly code = "mcp_unavailable";
  constructor() { super("mcp_unavailable"); }
}

/** Process-owned values only; no browser or environment-variable override. */
export interface AppAgentRuntime {
  compiled: boolean;
  executable: string;
  sourceEntrypoint: string;
}
const CURRENT_RUNTIME: AppAgentRuntime = {
  compiled: IS_COMPILED,
  executable: process.execPath,
  sourceEntrypoint: fileURLToPath(new URL("../../../mcp/src/bin.ts", import.meta.url)),
};

/** Metadata preflight never executes a candidate binary or searches PATH. */
export function resolveAppAgentMcpRuntime(runtime: AppAgentRuntime = CURRENT_RUNTIME): AppAgentMcpConfiguration {
  try {
    const command = runtime.compiled ? join(dirname(runtime.executable), "kizuki-mcp") : runtime.executable;
    if (!isAbsolute(command) || !statSync(command).isFile()) throw new AppAgentSetupError();
    accessSync(command, constants.X_OK);
    if (runtime.compiled) return { command, args: [] };
    if (!isAbsolute(runtime.sourceEntrypoint) || !statSync(runtime.sourceEntrypoint).isFile()) throw new AppAgentSetupError();
    return { command, args: [runtime.sourceEntrypoint] };
  } catch { throw new AppAgentSetupError(); }
}

export function enrollAppAgentSetup(
  vaultPath: string,
  request: AppAgentEnrollmentRequest,
  runtime: AppAgentRuntime = CURRENT_RUNTIME,
): AppAgentSetup {
  const launch = resolveAppAgentMcpRuntime(runtime);
  const enrolled = enrollAppAgent(vaultPath, request);
  return {
    receipt: enrolled.receipt,
    mcp: enrolled.token_ref === null ? null : {
      command: launch.command,
      args: [...launch.args, "--vault", resolve(vaultPath), "--token-ref", enrolled.token_ref],
    },
  };
}

export function revokeAppAgent(vaultPath: string, name: string): AgentEnrollmentResult {
  return revokeAgentEnrollment(vaultPath, name);
}
