export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Plain data object only: rejects arrays, null, and class instances, so a
 * validated `metadata` bag round-trips through JSON unchanged.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
