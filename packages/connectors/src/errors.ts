import { KizukiError } from "@kizuki/core";

export { KizukiError } from "@kizuki/core";
export type { KizukiErrorCode } from "@kizuki/core";

/** Honest refusal when a manifest capability is absent. */
export function notSupported(connectorId: string, capability: string): never {
  throw new KizukiError(
    "not_supported",
    `${connectorId}: ${capability} is not supported`,
    { retryable: false },
  );
}
