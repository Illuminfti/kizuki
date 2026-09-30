import { compareRfc3339 } from "../../agents/time";
import { isRfc3339 } from "../../util/time";
import { isPlainObject } from "../../util/validate";
import type {
  ViewToken,
  WorldKnownAt,
  WorldObjectRef,
  WorldRecord,
  WorldSnapshotRef,
  WorldValidQuery,
} from "./types";

const WIRE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function exact(value: WorldRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Every required key present and no key beyond the required and optional ones. */
export function hasWorldKeys(
  value: WorldRecord,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

export function isWorldWireToken(value: string): boolean {
  if (!WIRE_TOKEN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function parseWorldRef(
  value: unknown,
  kind: "object",
): WorldObjectRef | null;
export function parseWorldRef(
  value: unknown,
  kind: "snapshot",
): WorldSnapshotRef | null;
export function parseWorldRef(
  value: unknown,
  kind: "view",
): ViewToken | null;
export function parseWorldRef(
  value: unknown,
  kind: "object" | "snapshot" | "view",
): WorldObjectRef | WorldSnapshotRef | ViewToken | null {
  if (!isPlainObject(value) || !exact(value, ["kind", "token"])) return null;
  if (
    value.kind !== kind ||
    typeof value.token !== "string" ||
    !isWorldWireToken(value.token)
  ) {
    return null;
  }
  return { kind, token: value.token };
}

export function parseWorldValid(value: unknown): WorldValidQuery | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "all")
    return exact(value, ["kind"]) ? { kind: "all" } : null;
  if (value.kind === "unknown_only") {
    return exact(value, ["kind"]) ? { kind: "unknown_only" } : null;
  }
  if (value.kind === "at") {
    if (!exact(value, ["kind", "at"]) || !isRfc3339(value.at)) return null;
    return { kind: "at", at: value.at };
  }
  if (value.kind === "overlap") {
    if (
      !exact(value, ["kind", "from", "until"]) ||
      !isRfc3339(value.from) ||
      !isRfc3339(value.until)
    ) {
      return null;
    }
    if (compareRfc3339(value.from, "from", value.until, "until") >= 0)
      return null;
    return { kind: "overlap", from: value.from, until: value.until };
  }
  return null;
}

export function parseWorldKnownAt(value: unknown): WorldKnownAt | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "current")
    return exact(value, ["kind"]) ? { kind: "current" } : null;
  if (value.kind === "time") {
    if (!exact(value, ["kind", "at"]) || !isRfc3339(value.at)) return null;
    return { kind: "time", at: value.at };
  }
  if (value.kind === "snapshot") {
    if (!exact(value, ["kind", "ref"])) return null;
    const ref = parseWorldRef(value.ref, "snapshot");
    return ref === null ? null : { kind: "snapshot", ref };
  }
  return null;
}
