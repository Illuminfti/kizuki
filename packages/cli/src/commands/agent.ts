import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  AgentEnrollmentError,
  amendAgentGrant,
  enrollAgent,
  inspectAgents,
  previewAgentEnrollment,
  revokeAgentEnrollment,
  type AgentEnrollmentErrorCode,
  type AgentEnrollmentResult,
  type AgentGrantResult,
  type AgentInventoryEntry,
  type Grant,
} from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { configPath, readConfig } from "../config";
import { resolveVault, withReadVault } from "../context";
import { AGENT_GRANT_SCHEMA, AGENT_LIST_SCHEMA, AGENT_REVOKE_SCHEMA } from "../option-schema";
import { jsonEnvelope, table } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const AGENT_SCHEMA = {
  options: ["--grant", "--token-ref", "--operation-id"],
  flags: ["--dry-run", "--json"],
} as const satisfies CommandHelpSchema;

const USAGE = "agent add NAME --grant FILE --token-ref file:/absolute/path --operation-id ID [--dry-run] [--json] | agent grant NAME --grant FILE --operation-id ID [--json] | agent list [--json] | agent revoke NAME [--json]";
const MAX_GRANT_BYTES = 32 * 1024;

const MESSAGES: Record<AgentEnrollmentErrorCode, string> = {
  invalid_request: "Use one explicit agent name, complete grant, private file reference and operation ID.",
  invalid_grant: "The grant must contain exactly the eight supported fields with valid values.",
  vault_unavailable: "The selected vault is unavailable. Check the vault selection and its private custody.",
  unsupported_platform: "Private credential delivery requires qualified Linux x64 glibc custody.",
  credential_unsafe: "The credential destination must have a private owner-controlled parent and safe ancestry.",
  credential_conflict: "The credential destination conflicts with existing state. Preserve it and choose a new destination.",
  operation_conflict: "This operation ID belongs to a different request. Retry the original request or choose a new operation ID.",
  name_conflict: "This agent name is already active or reserved. Preserve its setup and choose a different name.",
  migration_required: "Execution requires the current ledger migration. Preview left the existing vault unchanged.",
  enrollment_busy: "The vault is busy or preview requires a stable checkpoint without journal sidecars. Retry the same operation ID and request.",
  recovery_required: "Enrollment is incomplete and its credential is inactive. Preserve the file; revoke the pending name before using a new operation ID and destination.",
  enrollment_unavailable: "Enrollment could not be reconciled. Retry the same operation ID and request before starting another setup.",
  unknown_agent: "No active agent has this name. Revoked and unfinished setups cannot be amended; list agents to check the name.",
};

/** Bounded input parsing only. Core validates every grant field and meaning. */
function readGrant(path: string): Grant {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_GRANT_BYTES)) {
      throw new Error("invalid grant file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new Error("incomplete grant file");
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mode !== after.mode || before.nlink !== after.nlink || before.uid !== after.uid ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("changed grant file");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Grant;
  } catch {
    throw new AgentEnrollmentError("invalid_grant");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function selectedVault(io: CliIo): string {
  try {
    return resolveVault(io.env, readConfig(configPath(io.env)), io.vaultOverride);
  } catch { throw new AgentEnrollmentError("vault_unavailable"); }
}

function setupSucceeded(result: AgentEnrollmentResult): boolean {
  return result.status === "preview" ||
    (result.status === "completed" && result.authority === "active" && result.credential === "ready");
}

function describe(result: AgentEnrollmentResult, revoke: boolean): string {
  if (revoke) return `Agent ${result.name}: ${result.authority === "revoked" ? "revoked" : "pending enrollment cancelled"}.`;
  if (result.status === "preview") return `Agent ${result.name}: setup validated. No identity or credential was created.`;
  if (setupSucceeded(result)) return `Agent ${result.name}: ${result.replayed ? "already enrolled" : "enrolled"}. Credential ready; grant epoch ${result.grant_epoch}.`;
  return `Agent ${result.name}: ${result.status}; authority=${result.authority}; credential=${result.credential}.`;
}

function scope(items: readonly string[] | null): string {
  return items === null ? "all" : items.length === 0 ? "none" : items.join(",");
}

/** Everything an owner needs to judge an agent's reach in one row; no credential fields exist here. */
function summaryRow(agent: AgentInventoryEntry): string[] {
  const grant = agent.grant;
  return [agent.name, agent.state, `epoch ${agent.grant_epoch}`, ...(grant === null ? ["grant unreadable"] : [
    `ceiling=${grant.ceiling}`, `tools=${grant.tools.length === 0 ? "none" : grant.tools.join(",")}`,
    `types=${scope(grant.types)}`, `subjects=${scope(grant.subjects)}`, `rate=${grant.rate_limit_per_minute}/min`,
    `relay=${grant.relay_owner_corrections ? "on" : "off"}`,
  ])];
}

async function listAgents(io: CliIo, json: boolean): Promise<number> {
  let agents: AgentInventoryEntry[];
  try { agents = await withReadVault(io, async ctx => inspectAgents(ctx.db)); }
  catch { throw new AgentEnrollmentError("vault_unavailable"); }
  if (json) io.out(jsonEnvelope("agent", "ok", { agents }));
  else io.out(agents.length === 0 ? "No agents are enrolled." : table(agents.map(summaryRow)).join("\n"));
  return 0;
}

function describeGrant(result: AgentGrantResult): string {
  return `Agent ${result.name}: grant ${result.replayed ? "already amended" : "amended"}; grant epoch ${result.grant_epoch}. Its credential is unchanged.`;
}

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "connect a scoped agent, list agents, amend a grant in place, or revoke access",
  schema: AGENT_SCHEMA,
  async run(io, args): Promise<number> {
    const json = args.includes("--json");
    try {
      const action = args[0];
      if (action !== "add" && action !== "revoke" && action !== "grant" && action !== "list") throw new UsageError(USAGE);
      const schema = { add: AGENT_SCHEMA, grant: AGENT_GRANT_SCHEMA, list: AGENT_LIST_SCHEMA, revoke: AGENT_REVOKE_SCHEMA }[action];
      const parsed = parseArguments(args.slice(1), { options: [...schema.options], flags: [...schema.flags] });
      if (parsed.positionals.length !== (action === "list" ? 0 : 1)) throw new UsageError(USAGE);
      if (action === "list") return await listAgents(io, json);
      const name = parsed.positionals[0]!;
      if (action === "grant") {
        const grantPath = parsed.options.get("--grant"), operationId = parsed.options.get("--operation-id");
        if (grantPath === undefined || operationId === undefined) throw new UsageError(USAGE);
        const amended = amendAgentGrant(selectedVault(io), { name, grant: readGrant(grantPath), operation_id: operationId });
        io.out(json ? jsonEnvelope("agent", "ok", amended) : describeGrant(amended));
        return 0;
      }
      let result: AgentEnrollmentResult;
      if (action === "revoke") {
        result = revokeAgentEnrollment(selectedVault(io), name);
      } else {
        const grantPath = parsed.options.get("--grant");
        const tokenRef = parsed.options.get("--token-ref");
        const operationId = parsed.options.get("--operation-id");
        if (grantPath === undefined || tokenRef === undefined || operationId === undefined) throw new UsageError(USAGE);
        const request = { name, grant: readGrant(grantPath), token_ref: tokenRef, operation_id: operationId };
        const vault = selectedVault(io);
        result = parsed.flags.has("--dry-run")
          ? previewAgentEnrollment(vault, request)
          : enrollAgent(vault, request);
      }
      const ok = action === "revoke"
        ? result.authority === "revoked" || (result.status === "cancelled" && result.authority === "none")
        : setupSucceeded(result);
      io.out(json ? jsonEnvelope("agent", ok ? "ok" : "error", result) : describe(result, action === "revoke"));
      if (!ok) {
        io.err(result.status === "pending" ? MESSAGES.recovery_required
          : "Setup is not active with its original credential. Enrollment retry will not restore a changed grant or credential.");
      }
      return ok ? 0 : 1;
    } catch (error) {
      const code: AgentEnrollmentErrorCode = error instanceof UsageError ? "invalid_request"
        : error instanceof AgentEnrollmentError ? error.code : "enrollment_unavailable";
      const message = MESSAGES[code];
      if (json) io.out(jsonEnvelope("agent", "error", null, { error: { code, message } }));
      io.err(`${code}: ${message}`);
      if (code === "invalid_request") io.err(`usage: ${USAGE}`);
      return code === "invalid_request" || code === "invalid_grant" ? 2 : 1;
    }
  },
};
