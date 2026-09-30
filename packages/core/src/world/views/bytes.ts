import { canonicalJson } from "../../util/hash";
import { isWorldWireToken } from "../ops/parse";

const REF_KINDS = new Set(["object", "claim", "admission", "event_version", "principal"]);

/**
 * The canonical bytes `unchanged` is decided on: the operation and the whole
 * authorized body, with keys sorted at every depth. Response time, token
 * lifetime and the view token itself are not part of a body, so they cannot
 * make two equal projections differ.
 */
export function projectionBytes(operation: string, data: unknown): Uint8Array {
  return Buffer.from(canonicalJson({ operation, data }), "utf8");
}

/**
 * Every issued reference a body names, once each. Evidence omitted from the
 * body is collected by the projection and linked alongside these references.
 */
export function wireRefs(data: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // Discovery carries its issued object reference as a bare cursor string,
      // including an empty final page whose body names no other reference.
      if (typeof record.cursor === "string" && isWorldWireToken(record.cursor)) found.add(record.cursor);
      const { kind, token } = record;
      if (
        Object.keys(record).length === 2 &&
        typeof kind === "string" &&
        REF_KINDS.has(kind) &&
        typeof token === "string" &&
        isWorldWireToken(token)
      ) {
        found.add(token);
        return;
      }
      for (const item of Object.values(record)) visit(item);
    }
  };
  visit(data);
  return [...found].sort();
}
