/**
 * Private output provenance, never a wire-shape exemption. Only an issuer that
 * has minted or resolved a capability may mark its exact opaque fields. Copies,
 * parsed JSON and captured lookalikes have no mark. Frozen copies prevent an
 * issued object from being changed into a credential-bearing payload later.
 */
const issued = new WeakMap<object, ReadonlyMap<string, string>>();
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function issuedOpaqueFields<T extends object>(value: T, keys: readonly (keyof T & string)[]): Readonly<T> {
  const copy = { ...value };
  const fields = new Map<string, string>();
  for (const key of keys) {
    const token = copy[key];
    if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("invalid issued opaque field");
    fields.set(key, token);
  }
  Object.freeze(copy);
  issued.set(copy, fields);
  return copy;
}

/** Used only by the output scrubber; string equality alone never grants trust. */
export function isIssuedOpaqueField(value: object, key: string, item: unknown): boolean {
  return typeof item === "string" && issued.get(value)?.get(key) === item;
}
