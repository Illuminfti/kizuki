export interface DecodedBytes {
  text: string;
  /** Set when the label was unusable and windows-1252 stood in for it. */
  fallback?: string;
}

const FALLBACK_LABEL = "windows-1252";

/**
 * Decodes with the declared label, falling back to windows-1252 when this
 * platform has no decoder for it. The label travels to metadata so a garbled
 * body is explained rather than silently wrong.
 */
export function decodeCharset(bytes: Uint8Array, label: string): DecodedBytes {
  const trimmed = label.trim().replace(/^["']|["']$/g, "");
  const wanted = trimmed.length === 0 ? "utf-8" : trimmed;
  try {
    return { text: new TextDecoder(wanted, { fatal: false }).decode(bytes) };
  } catch {
    return {
      text: new TextDecoder(FALLBACK_LABEL, { fatal: false }).decode(bytes),
      fallback: wanted,
    };
  }
}
