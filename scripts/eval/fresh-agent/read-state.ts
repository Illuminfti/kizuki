import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServeContext } from "../../../packages/core/src/serving/types";
import { canonicalJson } from "../../../packages/core/src/util/hash";

/** Public typed reads may allocate these six reference tables only. Every
 * other derived or authoritative table remains part of the equality witness. */
const REFERENCE_TABLES = ["world_authorization_namespaces", "world_wire_refs", "world_wire_object_targets",
  "world_wire_claim_targets", "world_wire_admission_targets", "world_wire_event_version_targets"] as const;
const TARGETS = { object: "world_wire_object_targets", claim: "world_wire_claim_targets",
  admission: "world_wire_admission_targets", event_version: "world_wire_event_version_targets" } as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Row = Record<string, string | number | null>;

export function baselineReadState(ctx: Pick<ServeContext, "db" | "vaultPath">) {
  const rows = (table: string): Row[] => ctx.db.query<Row, []>(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
  const tables = ctx.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const references = new Map<string, Row[]>(REFERENCE_TABLES.map(name => [name, rows(name)]));
  const parts: unknown[] = tables.filter(({ name }) => name !== "agent_audit" && !references.has(name)).map(({ name }) => [name, hash(JSON.stringify(rows(name)))]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === ctx.vaultPath && name === ".kizuki") continue;
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) parts.push([path.slice(ctx.vaultPath.length), hash(readFileSync(path))]);
      else throw new Error("unexpected fixture filesystem entry");
    }
  };
  walk(ctx.vaultPath);
  try { parts.push(hash(readFileSync(join(ctx.vaultPath, ".kizuki", "receipts", "promotions.jsonl")))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { data: hash(JSON.stringify(parts)), references };
}

/** Existing mappings cannot change. New mappings must be well-typed and bound
 * to the exact current reader; a broad world_* exception would hide mutations. */
export function baselineReadUnchanged(before: ReturnType<typeof baselineReadState>, ctx: ServeContext): boolean {
  const after = baselineReadState(ctx);
  if (before.data !== after.data || ctx.db.query("PRAGMA foreign_key_check").get() !== null) return false;
  const principal = ctx.principal, principalId = principal.kind === "owner" ? "owner" : principal.agent.agent_id;
  const namespace = after.references.get("world_authorization_namespaces")!.find(row => row.principal_id === principalId);
  const authorization = canonicalJson({ schema: "kizuki.world-view/v1", purpose: "recall", kind: principal.kind,
    grant: { ...principal.grant, types: principal.grant.types === null ? null : [...new Set(principal.grant.types)].sort(),
      subjects: principal.grant.subjects === null ? null : [...new Set(principal.grant.subjects)].sort(), tools: [...new Set(principal.grant.tools)].sort() },
    grant_epoch: principal.kind === "owner" ? null : principal.grant_epoch });
  for (const table of REFERENCE_TABLES) {
    const old = new Set(before.references.get(table)!.map(canonicalJson)), current = after.references.get(table)!;
    const currentSet = new Set(current.map(canonicalJson));
    if ([...old].some(row => !currentSet.has(row))) return false;
    for (const row of current.filter(value => !old.has(canonicalJson(value)))) {
      if (namespace === undefined || namespace.authorization !== authorization || row.namespace_id !== namespace.namespace_id) return false;
      if (table === "world_authorization_namespaces") { if (row.principal_id !== principalId) return false; continue; }
      const ref = after.references.get("world_wire_refs")!.find(ref => ref.namespace_id === row.namespace_id && ref.wire_ref === row.wire_ref);
      if (ref === undefined || typeof ref.ref_kind !== "string" || !Object.hasOwn(TARGETS, ref.ref_kind)) return false;
      const targetTable = TARGETS[ref.ref_kind as keyof typeof TARGETS];
      if (table !== "world_wire_refs" && targetTable !== table) return false;
      const target = after.references.get(targetTable)!.find(target => target.namespace_id === row.namespace_id && target.wire_ref === row.wire_ref);
      if (target === undefined) return false;
      if (ref.ref_kind === "event_version" && !exactEvent(ctx.db, target)) return false;
    }
  }
  return true;
}
function exactEvent(db: Database, target: Row): boolean {
  const event = db.query<Row, [string]>("SELECT * FROM events WHERE event_id=?").get(String(target.event_id));
  return event !== null && ["content_hash_version", "content_hash", "text_hash", "origin_binding", "accepted_at"].every(key => event[key] === target[key]);
}
