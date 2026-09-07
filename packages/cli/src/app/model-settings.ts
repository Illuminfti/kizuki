import { join, resolve } from "node:path";
import {
  AppModelSettingsError, isPlainObject, normalizeSourceModelEndpoint, normalizeSourceModelName,
  readAppModelConfiguration, classifyAppModelCredential, readAppModelFileCredential, saveAppModelConfiguration,
  type AppModelCredentialChange, type AppModelDocument,
} from "@kizuki/core";
import { chatCompletionsUrl, createOpenAiCompatibleLlmPort, parseOpenAiCompatibleConfig, type OpenAiCompatibleLlmConfig } from "@kizuki/llm";
import { tokenResolver } from "../secrets";

export { AppModelSettingsError } from "@kizuki/core";
export type ModelSelectionInput = { readonly kind: "none" } | { readonly kind: "openai_compatible"; readonly base_url: string; readonly model: string };
export type ModelSelection = { readonly kind: "none" } | { readonly kind: "openai_compatible"; readonly base_url: string; readonly model: string; readonly model_endpoint: string };
export interface AppModelTestResult {
  readonly revision: string; readonly at: string; readonly outcome: "succeeded" | "failed";
  readonly latency_ms: number; readonly error_code: string | null;
}
export interface AppModelSettingsStatus {
  readonly revision: string; readonly selection: ModelSelection;
  readonly credential: "none" | "configured" | "unavailable"; readonly last_test: null;
}
export interface AppModelSaveInput { readonly expected_revision: string; readonly selection: ModelSelectionInput; readonly credential: AppModelCredentialChange }
interface Configured { selection: ModelSelection; config: OpenAiCompatibleLlmConfig | null; secret_ref: string | null }
const NONE = "kizuki.llm.none", OPENAI = "kizuki.llm.openai-compatible";

function invalid(): never { throw new AppModelSettingsError("configuration_invalid"); }
function configured(value: unknown): Configured {
  try {
    if (value === undefined || value === NONE) return { selection: { kind: "none" }, config: null, secret_ref: null };
    if (!isPlainObject(value)) invalid();
    const config = { ...value }; delete config.id;
    if (value.id === NONE) {
      if (Object.keys(config).some(key => key !== "secret_ref")) invalid();
      // Reuse the actual LLM parser for the optional reference even while off.
      const parsed = parseOpenAiCompatibleConfig({ base_url: "http://127.0.0.1", model: "disabled", ...config });
      return { selection: { kind: "none" }, config: null, secret_ref: parsed.secret_ref };
    }
    if (value.id !== OPENAI) invalid();
    const parsed = parseOpenAiCompatibleConfig(config);
    const model = normalizeSourceModelName(parsed.model);
    const model_endpoint = normalizeSourceModelEndpoint(chatCompletionsUrl(parsed.base_url));
    return { selection: { kind: "openai_compatible", base_url: parsed.base_url, model, model_endpoint }, config: parsed, secret_ref: parsed.secret_ref };
  } catch { invalid(); }
}
const validateConfiguration = (value: unknown): void => { configured(value); };
export function readModelSelection(vaultPath: string, options: { reconcile?: boolean } = {}): { revision: string; selection: ModelSelection } {
  const document = readAppModelConfiguration(vaultPath, validateConfiguration, options);
  return { revision: document.revision, selection: configured(document.llm).selection };
}
async function credential(vaultPath: string, document: AppModelDocument, selected: Configured, env: Record<string, string | undefined>, options: { reconcile?: boolean } = {}): Promise<string | null> {
  const ref = selected.secret_ref;
  if (ref === null) return null;
  return classifyAppModelCredential(vaultPath, ref) === "env"
    ? tokenResolver(ref, env)(ref)
    : readAppModelFileCredential(vaultPath, document.revision, ref, options);
}
async function status(vaultPath: string, document: AppModelDocument, env: Record<string, string | undefined>, options: { reconcile?: boolean } = {}): Promise<AppModelSettingsStatus> {
  const selected = configured(document.llm);
  let availability: AppModelSettingsStatus["credential"] = "none";
  if (selected.secret_ref !== null) {
    try { await credential(vaultPath, document, selected, env, options); availability = "configured"; }
    catch { availability = "unavailable"; }
  }
  return { revision: document.revision, selection: selected.selection, credential: availability, last_test: null };
}
export async function readModelSettings(vaultPath: string, env: Record<string, string | undefined> = {}, options: { reconcile?: boolean } = {}): Promise<AppModelSettingsStatus> {
  return status(vaultPath, readAppModelConfiguration(vaultPath, validateConfiguration, options), env, options);
}
export async function saveModelSettings(vaultPath: string, input: AppModelSaveInput, env: Record<string, string | undefined> = {}): Promise<AppModelSettingsStatus> {
  if (!isPlainObject(input) || Object.keys(input).sort().join() !== "credential,expected_revision,selection" || typeof input.expected_revision !== "string" ||
      !isPlainObject(input.selection) || !isPlainObject(input.credential)) invalid();
  const selection = input.selection;
  const previous = readAppModelConfiguration(vaultPath, validateConfiguration);
  if (previous.revision !== input.expected_revision) throw new AppModelSettingsError("revision_conflict");
  let llm: Record<string, unknown>;
  if (selection.kind === "none" && Object.keys(selection).join() === "kind") llm = { id: NONE };
  else if (selection.kind === "openai_compatible" && Object.keys(selection).sort().join() === "base_url,kind,model") {
    const checked = configured({ id: OPENAI, base_url: selection.base_url, model: selection.model });
    llm = { ...(isPlainObject(previous.llm) && previous.llm.id === OPENAI ? previous.llm : {}),
      id: OPENAI, base_url: checked.config!.base_url, model: checked.config!.model };
  } else invalid();
  const keys = Object.keys(input.credential).sort().join();
  if (keys !== (input.credential.action === "replace" ? "action,value" : "action")) invalid();
  const document = saveAppModelConfiguration(vaultPath, { expected_revision: input.expected_revision, llm, credential: input.credential }, validateConfiguration);
  return status(vaultPath, document, env);
}
/** One immutable configuration/credential snapshot and one fixed synthetic call. */
export async function testModelSettings(vaultPath: string, expectedRevision: string, env: Record<string, string | undefined> = {}): Promise<AppModelTestResult> {
  const document = readAppModelConfiguration(vaultPath, validateConfiguration);
  if (document.revision !== expectedRevision) throw new AppModelSettingsError("revision_conflict");
  const selected = configured(document.llm), started = Date.now();
  const result = (outcome: AppModelTestResult["outcome"], error_code: string | null): AppModelTestResult => ({
    revision: document.revision, at: new Date().toISOString(), outcome, latency_ms: Math.max(0, Date.now() - started), error_code,
  });
  if (selected.config === null) return result("failed", "model_unconfigured");
  let secret: string | null;
  try { secret = await credential(vaultPath, document, selected, env); }
  catch { return result("failed", "credential_unavailable"); }
  const port = createOpenAiCompatibleLlmPort({
    vault_path: resolve(vaultPath), data_dir: join(resolve(vaultPath), ".kizuki/app-model"),
    config: { ...selected.config, timeout_ms: 15_000, max_retries: 0 },
    secrets: async requested => {
      if (secret === null || requested !== selected.secret_ref) throw new AppModelSettingsError("credential_invalid");
      return secret;
    },
    clock: () => new Date().toISOString(), logger: () => {},
  });
  try {
    await port.complete({ messages: [{ role: "user", content: "Reply with OK. This is a synthetic connection test containing no personal data." }], max_output_tokens: 8, deadline_ms: 15_000 });
    return result("succeeded", null);
  } catch { return result("failed", "model_test_failed"); }
  finally { secret = null; await port.close(); }
}
