import type { SystemOnePort } from "@kizuki/core/contracts";
import type { EvaluationScope, ReflexHost } from "./systemone";
import type { SnapshotBinding } from "./types";
import { ReflexError } from "./validate";

export interface HostPolicy {
  /** Reload authoritative state, including revision and access-policy changes. */
  isCurrent(binding: SnapshotBinding): Promise<boolean>;
  /** Must resolve source ownership and destination-specific model-egress grants. */
  allowModelEgress(scope: EvaluationScope, model_ref: string): Promise<boolean>;
}
/**
 * Explicit opt-in adapter to an EXISTING configured port. Only a trusted Kizuki
 * host may construct this; never implement policy as an agent-supplied boolean.
 * The library cannot reconstruct core's authority state from a JSON snapshot.
 */
export function bindReflexHost(port: Pick<SystemOnePort, "model_ref" | "evaluate">, policy: HostPolicy): ReflexHost {
  return {
    isCurrent: (binding) => policy.isCurrent(binding),
    async evaluateAuthorized(request, scope) {
      const model = port.model_ref;
      if (model === null) throw new ReflexError("not_configured");
      if (!await policy.isCurrent(scope.binding)) throw new ReflexError("stale_snapshot");
      if (!await policy.allowModelEgress(scope, model)) throw new ReflexError("host_unavailable");
      if (port.model_ref !== model || !await policy.isCurrent(scope.binding)) throw new ReflexError("stale_snapshot");
      return port.evaluate(request);
    },
  };
}
