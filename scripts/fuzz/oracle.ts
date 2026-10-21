function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Serving can report an internal failure inside an otherwise successful
 * envelope: an owner envelope carries it as an `error` denial, and any
 * scoped packet identifies storage failure in its incomplete result reasons.
 * Legacy packets use `context-unavailable`. Only trusted envelope fields are
 * read; ordinary coverage and captured words are never crash signals.
 */
export function assertServingEnvelope(value: unknown, failure: string): void {
  if (!isRecord(value)) return;
  const denied = Array.isArray(value["denied"]) ? value["denied"] : [];
  const data = value["data"];
  const legacyDegraded = isRecord(data) && Array.isArray(data["retrieval_degraded"]) ? data["retrieval_degraded"] : [];
  const result = isRecord(data) ? data["result"] : undefined;
  const packet = isRecord(result) ? result["data"] : undefined;
  const scopedPacket = value["schema"] === "kizuki.envelope/v2" && value["tool"] === "context_packet"
    && isRecord(data) && data["schema"] === "kizuki.context-packet/v2";
  const scopedDegraded = scopedPacket && isRecord(packet) && Array.isArray(packet["retrievalDegraded"]) ? packet["retrievalDegraded"] : [];
  const storageFailure = scopedPacket && isRecord(result) && result["status"] === "incomplete"
    && Array.isArray(result["reasons"]) && result["reasons"].includes("storage");
  const degraded = [...legacyDegraded, ...scopedDegraded];
  if (denied.some(item => isRecord(item) && item["reason"] === "error") || degraded.includes("context-unavailable") || storageFailure) throw new Error(failure);
}
