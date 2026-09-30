import { consentsToJudge, type DeclaredRetention, type ExternalRetention, type SourceGrant } from "@kizuki/core";
import type { ProviderPrivacy } from "@kizuki/llm";
import { readModelEgress } from "./app/model-settings";
import { configuredJudgeDestination } from "./judge-destination";

/** What each retention class a grant can accept means for the owner reading a status line. */
export const RETENTION_MEANING: Readonly<Record<ExternalRetention, string>> = {
  zero_retention: "the grant accepts only a model that declares zero retention",
  logged_no_training: "the grant accepts a model that declares no more than logging without training",
  logged_and_trained: "the grant accepts a model that may log and train",
  provider_managed: "the provider keeps sent text under its own policy",
};

/** Where a source's captured text may go, and what its owner has been told about retention there. */
export interface EgressView {
  readonly destination: "none" | "local_only" | "model_endpoint";
  readonly host: string | null;
  readonly model: string | null;
  /** The loosest class the grant accepts. */
  readonly retention: "none" | ExternalRetention;
  /** The class the configured model declares in its port config; null when undeclared, which counts as the loosest. */
  readonly declared_retention: DeclaredRetention | null;
  /** What Kizuki asks the router to enforce. Null when nothing is requested or the granted model is not the configured one. */
  readonly provider_controls: ProviderPrivacy | null;
  /** True when the granted model is the one currently configured, so egress can occur. */
  readonly configured: boolean;
  /** The configured System One judge and whether this grant consents to it; null when no judge is configured. Without consent the source's events are held. */
  readonly judge: { readonly host: string; readonly model: string; readonly consented: boolean } | null;
}

const NOWHERE: EgressView = { destination: "none", host: null, model: null, retention: "none", declared_retention: null, provider_controls: null, configured: false, judge: null };

export function egressView(vaultPath: string, grant: SourceGrant | null): EgressView {
  if (grant === null || grant.status !== "active") return NOWHERE;
  const egress = grant.policy.egress;
  if (egress === "local_only") return { ...NOWHERE, destination: "local_only" };
  const configured = readModelEgress(vaultPath);
  const judge = configuredJudgeDestination(vaultPath);
  const bound = configured !== null && configured.model_endpoint === egress.model_endpoint && configured.model === egress.model;
  return {
    destination: "model_endpoint",
    host: new URL(egress.model_endpoint).host,
    model: egress.model,
    retention: egress.external_retention,
    declared_retention: bound ? configured.retention : null,
    provider_controls: bound ? configured.provider : null,
    configured: bound,
    judge: judge === null ? null : { host: new URL(judge.model_endpoint).host, model: judge.model, consented: consentsToJudge(egress, judge) },
  };
}

const controls = (provider: ProviderPrivacy): string[] => [
  ...(provider.data_collection === undefined ? [] : [`data_collection=${provider.data_collection}`]),
  ...(provider.zdr === undefined ? [] : [`zdr=${provider.zdr}`]),
  ...(provider.order === undefined ? [] : [`order=${provider.order.join(">")}`]),
  ...(provider.only === undefined ? [] : [`only=${provider.only.join(",")}`]),
  ...(provider.ignore === undefined ? [] : [`ignore=${provider.ignore.join(",")}`]),
  ...(provider.allow_fallbacks === undefined ? [] : [`allow_fallbacks=${provider.allow_fallbacks}`]),
];

export function egressDestination(view: EgressView): string {
  if (view.destination === "none") return "none";
  if (view.destination === "local_only") return "local only";
  const judge = view.judge === null ? "" : view.judge.consented
    ? `; judge ${view.judge.host} ${view.judge.model}`
    : `; held: judge not consented ${view.judge.host} ${view.judge.model} (check judge_endpoint, judge_model and external_retention)`;
  return `${view.host} ${view.model}${view.configured ? "" : " (not the configured model)"}${judge}`;
}

export function egressRetention(view: EgressView): string {
  if (view.retention === "none") return "none";
  const label = view.retention.replaceAll("_", "-");
  if (!view.configured) return label;
  const stated = view.retention === "provider_managed" ? label : `${label}; model declares ${view.declared_retention ?? "nothing"}`;
  const requested = view.provider_controls === null ? [] : controls(view.provider_controls);
  return requested.length === 0 ? `${stated}; no provider controls requested` : `${stated}; requests ${requested.join(" ")}`;
}
