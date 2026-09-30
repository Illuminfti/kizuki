/**
 * A redaction marker is longer than a short secret, so redacting a string that
 * already sat at its bound can push it past the bound the strict world_view
 * grammar states. The bounded strings are cut again after redaction, so one
 * planted label cannot make a whole answer unservable.
 */
const LABEL_MAX = 400;
const SUMMARY_MAX = 1200;

function cut(value: string, max: number): string {
  return value.length <= max ? value : Array.from(value).slice(0, max).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clamp);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (name === "labels" && Array.isArray(item)) {
      out[name] = item.map((label) =>
        typeof label === "string"
          ? cut(label, LABEL_MAX)
          : isRecord(label) && typeof label["text"] === "string"
            ? { ...(clamp(label) as Record<string, unknown>), text: cut(label["text"], LABEL_MAX) }
            : clamp(label),
      );
    } else if (name === "value" && typeof item === "string" && value["kind"] === "literal") {
      out[name] = cut(item, LABEL_MAX);
    } else if (name === "summary" && isRecord(item) && typeof item["text"] === "string") {
      out[name] = { ...(clamp(item) as Record<string, unknown>), text: cut(item["text"], SUMMARY_MAX) };
    } else {
      out[name] = clamp(item);
    }
  }
  return out;
}

/** `data` with every bounded world_view string cut to the bound the grammar states. */
export function clampWorldData<T>(data: T): T {
  return clamp(data) as T;
}
