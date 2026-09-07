import { join, resolve } from "node:path";
import { CanonFilesError, openCanonFiles } from "../vault/canon-files";
import { withMutationFilesSync } from "../vault/mutation-files";
import { VaultMutationError, withVaultMutationSync } from "../vault/mutation-scope";
import { AgentEnrollmentError, enrollAgent, validateAgentEnrollmentRequest, type AgentEnrollmentRequest, type AgentEnrollmentResult } from "./enrollment";

export type AppAgentEnrollmentRequest = Pick<AgentEnrollmentRequest, "name" | "grant" | "operation_id">;
export interface AppAgentEnrollmentResult {
  receipt: AgentEnrollmentResult;
  /** An existing private file reference, never the credential bytes. */
  token_ref: string | null;
}

const DIRECTORY = ".kizuki/agent-credentials";

/** Owner-app composition only; identity and token authority remain in enrollAgent. */
export function enrollAppAgent(vaultPath: string, request: AppAgentEnrollmentRequest): AppAgentEnrollmentResult {
  let normalized: AgentEnrollmentRequest;
  let root: string;
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).length !== 3 || Object.keys(request).some(key => !["name", "grant", "operation_id"].includes(key))) {
      throw new AgentEnrollmentError("invalid_request");
    }
    const { name, grant, operation_id } = request;
    if (typeof operation_id !== "string" || operation_id.length > 64) throw new AgentEnrollmentError("invalid_request");
    if (typeof vaultPath !== "string" || vaultPath.length === 0 || vaultPath.length > 4096 || vaultPath.includes("\0")) {
      throw new AgentEnrollmentError("vault_unavailable");
    }
    root = resolve(vaultPath);
    normalized = validateAgentEnrollmentRequest({ name, grant, operation_id, token_ref: `file:${join(root, DIRECTORY, `app-${operation_id}.json`)}` });
  } catch (error) {
    if (error instanceof AgentEnrollmentError) throw error;
    throw new AgentEnrollmentError("invalid_request");
  }
  try {
    // Check existing private control custody before the file-only writer opens.
    const check = openCanonFiles(root);
    try { check.assertPrivateDirectory(".kizuki"); } finally { check.close(); }
    const target = { vault_path: root };
    return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files => {
      files.assertPrivateDirectory(".kizuki");
      files.ensureDirectory(DIRECTORY);
      files.assertPrivateDirectory(DIRECTORY);
      const receipt = enrollAgent(root, normalized);
      files.assertPrivateDirectory(DIRECTORY);
      const ready = receipt.status === "completed" && receipt.authority === "active" && receipt.credential === "ready";
      return { receipt, token_ref: ready ? normalized.token_ref : null };
    }));
  } catch (error) {
    if (error instanceof AgentEnrollmentError) throw error;
    if (error instanceof VaultMutationError && error.code === "writer_busy") throw new AgentEnrollmentError("enrollment_busy");
    if (error instanceof CanonFilesError) {
      throw new AgentEnrollmentError(error.reason === "unsupported" || error.reason === "native_unavailable" ? "unsupported_platform" : "credential_unsafe");
    }
    throw new AgentEnrollmentError("enrollment_unavailable");
  }
}
