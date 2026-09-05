import { lstatSync, readFileSync, opendirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PortError, isRfc3339 } from "@kizuki/core";
import { EMBEDDED_RETRIEVAL_DESCRIPTOR } from "./descriptor";
import { EXTENSION_HASHES } from "./assets";

const MAX_ENTRIES = 100_000;
function refuse(): never { throw new PortError("unavailable", "owned retrieval generation is unsafe or exceeds maintenance bounds", false); }
function entries(path: string, limit: number): string[] {
  const dir = opendirSync(path), names: string[] = [];
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (names.length >= limit) refuse();
      names.push(entry.name);
    }
    return names;
  } finally { dir.closeSync(); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function regular(path: string, maxBytes = Number.MAX_SAFE_INTEGER) {
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) refuse();
  return st;
}
function json(path: string, maxBytes = 16_384): Record<string, unknown> {
  regular(path, maxBytes);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function holder(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["pid", "holder_id", "heartbeat_at", "acquired_at", "ownership_token"].includes(k)) &&
    Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && typeof v.holder_id === "string" && v.holder_id.length <= 256 &&
    isRfc3339(v.heartbeat_at) && isRfc3339(v.acquired_at) && (v.ownership_token === undefined || typeof v.ownership_token === "string" && /^[0-9a-f-]{36}$/.test(v.ownership_token));
}
function leaseMetadata(path: string, relative: string): void {
  const st = lstatSync(path);
  if (st.isDirectory()) {
    if (!["lease", "lease/held"].includes(relative)) refuse();
    for (const name of entries(path, 256)) leaseMetadata(join(path, name), `${relative}/${name}`);
    return;
  }
  regular(path, 4 * 1024 * 1024);
  const canonical = relative.replace(/\.[0-9a-f-]{36}\.tmp$/, "");
  if (canonical === "lease/writer.lock") { if (st.size !== 0) refuse(); return; }
  if (canonical === "lease/held/holder.json") { if (!holder(json(path))) refuse(); return; }
  if (canonical === "lease/queue.json") {
    const value = json(path, 262_144);
    if (Object.keys(value).join() !== "waiters" || !Array.isArray(value.waiters) || value.waiters.length > 1000 || value.waiters.some(v => typeof v !== "string" || v.length > 512)) refuse();
    return;
  }
  if (canonical === "lease/receipts.jsonl") {
    const content = readFileSync(path, "utf8");
    if (content && !content.endsWith("\n")) refuse();
    for (const line of content.split("\n").filter(Boolean)) {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (!v || Object.keys(v).sort().join() !== "action,at,holder,previous" || !["acquired", "released", "reclaimed"].includes(String(v.action)) || !isRfc3339(v.at) || !holder(v.holder) || !holder(v.previous)) refuse();
    }
    return;
  }
  refuse();
}
/** Validate only the fixed native managed root; never infer a deletion target from metadata. */
export function validateOwnedGeneration(vaultPath: string, dataDir: string): void {
  const absolute = resolve(dataDir);
  if (absolute !== resolve(vaultPath, ".kizuki", "retrieval", EMBEDDED_RETRIEVAL_DESCRIPTOR.id)) refuse();
  for (let parent = absolute, depth = 0; ; parent = dirname(parent)) {
    if (++depth > 256 || !lstatSync(parent).isDirectory()) refuse();
    if (parent === dirname(parent)) break;
  }
  const names = entries(absolute, 256);
  if (names.length > 256) refuse();
  for (const name of names) {
    const path = join(absolute, name);
    if (name === "store") {
      if (!lstatSync(path).isDirectory()) refuse();
      for (const child of entries(path, 5)) if (!["pgdata", "docs.json", "graph.json", "embed-checkpoint.json", "self-writes.json"].includes(child)) refuse();
      let count = 0;
      const walk = (entry: string, depth: number) => {
        if (++count > MAX_ENTRIES || depth > 64) refuse();
        const st = lstatSync(entry);
        if (st.isDirectory()) { for (const child of entries(entry, MAX_ENTRIES - count)) walk(join(entry, child), depth + 1); }
        else regular(entry);
      };
      walk(path, 0);
    } else if (name === "lease") leaseMetadata(path, name);
    else if (name === "engine.json" || /^engine\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) {
      const v = json(path);
      if (Object.keys(v).some(k => !["port", "contract", "contract_minor", "space", "created_at", "rebuilt_at", "engine", "schema"].includes(k)) ||
          v.port !== EMBEDDED_RETRIEVAL_DESCRIPTOR.id || v.contract !== EMBEDDED_RETRIEVAL_DESCRIPTOR.contract || v.contract_minor !== EMBEDDED_RETRIEVAL_DESCRIPTOR.contract_minor ||
          !isRfc3339(v.created_at) || (v.rebuilt_at !== null && !isRfc3339(v.rebuilt_at)) ||
          (v.space !== null && (typeof v.space !== "string" || v.space.length > 256)) ||
          (v.engine !== undefined && v.engine !== "pglite") || (v.schema !== undefined && v.schema !== 2)) refuse();
    } else if (/^assets-[A-Za-z0-9]{6}$/.test(name) && lstatSync(path).isDirectory()) {
      const files = entries(path, 2);
      if (files.length > 2) refuse();
      for (const file of files) {
        const key = file === "vector.tar.gz" ? "vector" : file === "trgm.tar.gz" ? "trgm" : null;
        if (key === null) refuse();
        const asset = join(path, file); regular(asset, 4 * 1024 * 1024);
        if (new Bun.CryptoHasher("sha256").update(readFileSync(asset)).digest("hex") !== EXTENSION_HASHES[key]) refuse();
      }
    } else refuse();
  }
}
/** Caller owns the existing native lease, root capability, and confirmed SQL shutdown. */
export function removeOwnedGeneration(vaultPath: string, dataDir: string, root: import("@kizuki/core").OwnedDirectory, store: import("@kizuki/core").OwnedDirectoryIdentity | null): void {
  root.assertCurrent();
  validateOwnedGeneration(vaultPath, dataDir);
  root.removeTree("store", store);
}
