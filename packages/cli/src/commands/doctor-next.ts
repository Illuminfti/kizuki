import type { inspectServeDoctor } from "@kizuki/core";

type ServeDoctor = ReturnType<typeof inspectServeDoctor>;

interface NextInput {
  readonly ok: boolean;
  readonly serve: ServeDoctor;
  readonly live_claims: readonly { readonly claim_id: string }[];
  readonly filed_claims: readonly unknown[];
}

/**
 * The one step that follows from the report. A failed report is answered from
 * its top failure and never with a correction hint: `tell` names a live claim
 * and repairs nothing a failure is about.
 */
export function nextStep(report: NextInput): string | null {
  if (!report.ok) return failureStep(report.serve);
  const firstLive = report.live_claims[0];
  if (firstLive !== undefined) return `next: kizuki tell "<statement>" --claim ${firstLive.claim_id}`;
  if (report.filed_claims.length > 0) {
    return "next: leftover skipped claims are not live; tell --claim needs a live claim. the writer is off until a model is configured.";
  }
  return null;
}

function failureStep(serve: ServeDoctor): string {
  const top = serve.top_failure;
  if (top?.kind === "model") {
    return serve.extraction.hint === null
      ? "next: the model call is failing; check the model endpoint and credential named above. The daemon retries every sync pass; `kizuki serve status` shows the latest."
      : "next: edit .kizuki/serve.toml as the extraction line says; the next sync pass retries with the new setting.";
  }
  if (top?.kind === "rail") {
    return `next: rail ${top.rail} is down for the reason above; \`kizuki serve status\` shows the daemon's latest state (read-only). Fix the cause, then run kizuki doctor again.`;
  }
  if (top?.kind === "service") {
    return "next: follow the serve-failure line above to restore the service, then run kizuki doctor again.";
  }
  return "next: fix the failure above, then run kizuki doctor again.";
}
