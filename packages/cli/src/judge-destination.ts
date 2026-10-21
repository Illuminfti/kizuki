import { normalizeSourceModelEndpoint, normalizeSourceModelName } from "@kizuki/core";
import { parseSystemOneJevConfig } from "@kizuki/llm";
import { loadSystemOneBinding } from "./vault-config";

const SYSTEMONE_JEV_ID = "kizuki.systemone.jev";

/**
 * The destination a configured System One judge sends extraction text to, in the form source consent
 * names it, or null when no judge is configured or its configuration cannot be read.
 */
export function configuredJudgeDestination(vaultPath: string): { readonly model_endpoint: string; readonly model: string } | null {
  try {
    const binding = loadSystemOneBinding(vaultPath);
    if (binding === null || binding.id !== SYSTEMONE_JEV_ID) return null;
    const judge = parseSystemOneJevConfig(binding.config);
    return { model_endpoint: normalizeSourceModelEndpoint(`${judge.base_url}/systemone`), model: normalizeSourceModelName(judge.model) };
  } catch { return null; }
}
