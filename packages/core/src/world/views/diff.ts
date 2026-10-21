import { WORLD_DIFF_FIELDS, WORLD_DIFF_SCHEMA, type WorldDiff } from "../../contracts/world-diff";
import { RELATION_SCHEMA, type WorldWireRef } from "../../contracts/world-card-kit";
import { canonicalJson } from "../../util/hash";
import { issuedOpaqueFields } from "../../util/issued-opaque";
import { isPlainObject } from "../../util/validate";
import { isWorldWireToken } from "../ops/parse";

const LIMIT = 128;
type Claims = Map<string, { ref: WorldWireRef<"claim">; relation?: Record<string, unknown> }>;

/** Only called with an authorized retained projection and a freshly built card. */
function claims(data: unknown): Claims {
  const found: Claims = new Map();
  const pending = [data];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!isPlainObject(value)) continue;
    const ref = value.schema === RELATION_SCHEMA ? value.claim : value;
    if (isPlainObject(ref) && Object.keys(ref).length === 2 && ref.kind === "claim" &&
      typeof ref.token === "string" && isWorldWireToken(ref.token)) {
      // Retained views were issued by this principal's namespace and checked
      // before parsing. These are stored issued references, never source text.
      const existing = found.get(ref.token);
      found.set(ref.token, {
        ref: issuedOpaqueFields({ kind: "claim", token: ref.token } as const, ["token"]),
        ...(value.schema === RELATION_SCHEMA ? { relation: value } : existing?.relation === undefined ? {} : { relation: existing.relation }),
      });
    }
    pending.push(...Object.values(value));
  }
  return found;
}

/** The reader checks whole-projection equality separately; a diff reports qualified assertions only. */
export function compareWorldViews(before: unknown, after: unknown): WorldDiff {
  const old = claims(before), current = claims(after);
  const added: WorldWireRef<"claim">[] = [], removed: WorldWireRef<"claim">[] = [];
  const changed: { claim: WorldWireRef<"claim">; fields: WorldDiff["changed"][number]["fields"] }[] = [];
  let truncated = false;
  for (const token of [...current.keys()].sort()) {
    const item = current.get(token)!, previous = old.get(token);
    if (previous === undefined) {
      if (added.length < LIMIT) added.push(item.ref); else truncated = true;
    } else if (item.relation !== undefined && previous.relation !== undefined) {
      const fields = WORLD_DIFF_FIELDS.filter(field => canonicalJson(item.relation![field]) !== canonicalJson(previous.relation![field]));
      if (fields.length > 0) {
        if (changed.length < LIMIT) changed.push({ claim: item.ref, fields }); else truncated = true;
      }
    }
  }
  for (const token of [...old.keys()].sort()) if (!current.has(token)) {
    if (removed.length < LIMIT) removed.push(old.get(token)!.ref); else truncated = true;
  }
  return { schema: WORLD_DIFF_SCHEMA, added, removed, changed, truncated };
}
