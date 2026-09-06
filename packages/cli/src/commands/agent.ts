import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  AgentEnrollmentError,
  enrollAgent,
  previewAgentEnrollment,
  revokeAgentEnrollment,
  type AgentEnrollmentErrorCode,
  type AgentEnrollmentResult,
  type Grant,
} from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { configPath, readConfig } from "../config";
import { resolveVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

const USAGE = "agent add NAME --grant FILE --token-ref file:/absolute/path --operation-id ID [--dry-run] [--json] | agent revoke NAME [--json]";
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

export const agentCommand: Command = {
  name: "agent",
  usage: USAGE,
  summary: "connect a scoped agent through a private credential file, or revoke its access",
  async run(io, args): Promise<number> {
    const json = args.includes("--json");
    try {
      const action = args[0];
      if (action !== "add" && action !== "revoke") throw new UsageError(USAGE);
      const parsed = parseArguments(args.slice(1), action === "add" ? {
        options: ["--grant", "--token-ref", "--operation-id"], flags: ["--dry-run", "--json"],
      } : { flags: ["--json"] });
      if (parsed.positionals.length !== 1) throw new UsageError(USAGE);
      const name = parsed.positionals[0]!;
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
