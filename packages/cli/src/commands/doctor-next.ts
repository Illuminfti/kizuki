import type { inspectServeDoctor } from "@kizuki/core";

type ServeDoctor = ReturnType<typeof inspectServeDoctor>;

interface NextInput {
  readonly ok: boolean;
  readonly serve: ServeDoctor;
  /** `correctable` is false when the claim's source grant would refuse `tell`. */
  readonly live_claims: readonly { readonly claim_id: string; readonly correctable: boolean }[];
  readonly filed_claims: readonly unknown[];
  readonly corrections_refused: readonly { readonly source_key: string; readonly revision: number }[];
}

/**
 * The one step that follows from the report. A failed report is answered from
 * its top failure and never with a correction hint: `tell` names a live claim
 * and repairs nothing a failure is about. `tell` is only suggested for a claim
 * the source grants let the owner correct.
 */
export function nextStep(report: NextInput): string | null {
  if (!report.ok) return failureStep(report.serve);
  const tellable = report.live_claims.find((claim) => claim.correctable);
  if (tellable !== undefined) return `next: kizuki tell "<statement>" --claim ${tellable.claim_id}`;
  const refusal = report.corrections_refused[0];
  if (refusal !== undefined) {
    return `next: kizuki connect grant --source ${refusal.source_key} --policy POLICY.json --expected-revision ${refusal.revision} --operation-id OPERATION (add "correction" to purposes; tell is refused until then)`;
  }
  if (report.live_claims.length > 0) {
    return "next: kizuki connect status (tell is refused for these claims; a source grant does not permit correction)";
  }
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
