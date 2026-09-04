import type { CaptureEventInput } from "../contracts/event";

/**
 * Fields that define event identity. `observed_at` is excluded so re-observing
 * an unchanged record dedupes; `attachments` and `sensitivity_hint` are
 * excluded so attachment re-hosting and hint revision do not fork history.
 */
const HASHED_FIELDS = [
  "connector_id",
  "source_record_id",
  "kind",
  "occurred_at",
  "text",
  "subjects",
  "deleted",
  "metadata",
] as const;

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    // UTF-16 code-unit order, the one ordering every JS engine agrees on.
    // defineProperty on a null-prototype object keeps attacker keys such as
    // __proto__ as data instead of mutating the accumulator.
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(sorted, key, {
        value: sortDeep(source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON over the identity fields with object keys sorted at every
 * depth. Array order is significant: `subjects` is a sequence, not a set.
 */
export function canonicalSerialize(event: CaptureEventInput): string {
  const subset: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    subset[field] = event[field];
  }
  return JSON.stringify(sortDeep(subset));
}

/**
 * The content hash is ALWAYS spine-computed. A connector-supplied
 * `content_hash` is never trusted or persisted — dedup and the
 * `event_id`-collision check both rest on this function alone.
 */
export function computeContentHash(input: CaptureEventInput): string {
  return sha256Hex(canonicalSerialize(input));
}

/** Hex SHA-256 of bytes or UTF-8 text. Used for event identity and opaque state. */
export function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}
