import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PortContext } from "../contracts/ports";
import { PortError } from "../contracts/ports";
import { tryAdvisoryFileLock } from "../util/advisory-file-lock";
import { isRfc3339 } from "../util/time";

const ID = "kizuki.retrieval.fts5";
function refuse(): never { throw new PortError("unavailable", "owned FTS generation is unsafe", false); }
function names(path: string, limit: number): string[] {
  const dir = opendirSync(path); const result: string[] = [];
  try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) { if (result.length >= limit) refuse(); result.push(entry.name); } }
  finally { dir.closeSync(); }
  return result;
}
export function validateFtsGeneration(ctx: Pick<PortContext, "vault_path" | "data_dir">): void {
  if (resolve(ctx.data_dir) !== resolve(ctx.vault_path, ".kizuki/retrieval", ID)) refuse();
  for (let path = resolve(ctx.data_dir), depth = 0; ; path = dirname(path)) {
    if (++depth > 256 || !lstatSync(path).isDirectory()) refuse();
    if (path === dirname(path)) break;
  }
  for (const name of names(ctx.data_dir, 4)) {
    const path = join(ctx.data_dir, name), stat = lstatSync(path);
    if (name === "store") {
      if (!stat.isDirectory()) refuse();
      for (const file of names(path, 4)) {
        if (!["retrieval.db", "retrieval.db-wal", "retrieval.db-shm", "retrieval.db-journal"].includes(file)) refuse();
        const entry = lstatSync(join(path, file)); if (!entry.isFile() || entry.nlink !== 1) refuse();
      }
    } else if (name === "writer.lock") {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) refuse();
    } else if (name === "engine.json" || name === "engine.json.tmp") {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) refuse();
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (!v || Object.keys(v).sort().join() !== "contract,contract_minor,created_at,port,rebuilt_at,space" || v.port !== ID || v.contract !== "kizuki.retrieval/v1" || v.contract_minor !== 0 || v.space !== null || !isRfc3339(v.created_at) || v.rebuilt_at !== null && !isRfc3339(v.rebuilt_at)) refuse();
    } else refuse();
  }
}
export function lockFtsGeneration(dataDir: string) {
  const lock = tryAdvisoryFileLock(join(dataDir, "writer.lock"));
  if (!lock) throw new PortError("unavailable", "owned FTS generation is busy", true);
  return lock;
}
export function removeFtsGeneration(ctx: Pick<PortContext, "vault_path" | "data_dir">, root: import("../util/owned-directory").OwnedDirectory, store: import("../util/owned-directory").OwnedDirectoryIdentity | null): void {
  root.assertCurrent();
  validateFtsGeneration(ctx);
  root.removeTree("store", store);
}
