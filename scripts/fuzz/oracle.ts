function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Serving can report an internal failure inside an otherwise successful
 * envelope: an owner envelope carries it as an `error` denial, and any
 * principal's packet carries it as a `context-unavailable` degradation. Only
 * trusted envelope fields are read; captured text is never an oracle code.
 */
export function assertServingEnvelope(value: unknown, failure: string): void {
  if (!isRecord(value)) return;
  const denied = Array.isArray(value["denied"]) ? value["denied"] : [];
  const data = value["data"];
  const degraded = isRecord(data) && Array.isArray(data["retrieval_degraded"]) ? data["retrieval_degraded"] : [];
  if (denied.some(item => isRecord(item) && item["reason"] === "error") || degraded.includes("context-unavailable")) throw new Error(failure);
}
