export function redactReceiptText(text: string): string {
  return text
    .replace(/\/(?:home|Users|tmp|var|workspace|opt)\/[^\s"']+/g, "[path]")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

export function redactReceiptError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactReceiptText(text).slice(0, 240);
}
