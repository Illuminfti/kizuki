import { createHash } from "node:crypto";
import { isRfc3339 } from "../packages/core/src/util/time";
import { isPlainObject } from "../packages/core/src/util/validate";

// Post-1.0 experiment only: not a connector, CLI verb, or canon writer.
// The caller selects one extracted My Activity JSON file, never a whole archive.
const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 10_000;

interface Activity {
  record_index: number;
  title: string;
  occurred_at: string;
  products: string[];
}

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= bytes &&
    // JSON escapes can decode to lone surrogates despite lossless source bytes.
    Buffer.from(value, "utf8").toString("utf8") === value;
}

/**
 * Deterministic selective projection. No filesystem, network, model, embedding,
 * or persistence calls. A receipt binds positions to the exact supplied bytes;
 * positions are not vendor IDs and the receipt is not a ledger admission proof.
 * Unknown fields are intentionally omitted, not interpreted as facts.
 */
export function distillTakeoutActivity(source: string | Uint8Array): {
  activities: Activity[];
  receipt: { input_sha256: string; input_bytes: number; records: number };
} {
  if (source.length > MAX_BYTES ||
    (typeof source === "string" && Buffer.byteLength(source, "utf8") > MAX_BYTES)) {
    throw new Error("Takeout activity exceeds byte limit");
  }
  // Copy only the selected byte view; the receipt binds the original encoding,
  // not replacement characters introduced by a caller's permissive decoder.
  const input = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
  const text = input.toString("utf8");
  if ((typeof source === "string" && text !== source) ||
    !Buffer.from(text, "utf8").equals(input)) {
    throw new Error("Takeout activity must be lossless UTF-8");
  }
  let rows: unknown;
  try {
    rows = JSON.parse(text) as unknown;
  } catch {
    // JSON parser diagnostics can repeat private source text.
    throw new Error("Takeout activity must be valid JSON");
  }
  if (!Array.isArray(rows)) throw new Error("Takeout activity must be an array");
  if (rows.length > MAX_RECORDS) throw new Error("Takeout activity exceeds record limit");
  const activities = rows.map((row: unknown, record_index): Activity => {
    if (!isPlainObject(row) || !boundedText(row["title"], 8192) ||
      !isRfc3339(row["time"]) || !Array.isArray(row["products"]) ||
      row["products"].length > 32 ||
      !row["products"].every((product: unknown) => boundedText(product, 256))) {
      throw new Error(`Takeout activity record ${record_index} has unsupported fields`);
    }
    return {
      record_index,
      title: row["title"],
      // Preserve source precision and offset; do not silently round timestamps.
      occurred_at: row["time"],
      products: row["products"].slice() as string[],
    };
  });
  return {
    activities,
    receipt: {
      input_sha256: createHash("sha256").update(input).digest("hex"),
      input_bytes: input.length,
      records: activities.length,
    },
  };
}
