import { resolve } from "node:path";
import { CanonFilesError, openCanonFiles, type CanonFiles, type CanonFileSnapshot } from "../vault/canon-files";
import { withMutationFilesSync } from "../vault/mutation-files";
import { VaultMutationError, withVaultMutationSync } from "../vault/mutation-scope";
import type { ServeProcessMarker } from "./daemon";

const MARKER = ".kizuki/serve.pid";
const REQUEST = ".kizuki/serve-stop.json";
const STAGING = ".kizuki/.serve-stop.tmp";
const SCHEMA = "kizuki.serve-stop/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ServeStopError extends Error {
  override readonly name = "ServeStopError";
  constructor(readonly code: "not_running" | "unsafe" | "busy" | "changed" | "unavailable") {
    super({ not_running: "serve has no current instance marker", unsafe: "serve stop control custody is unsafe",
      busy: "serve stop request is busy; retry", changed: "serve instance changed; retry", unavailable: "serve stop control is unavailable" }[code]);
  }
}
export interface ServeStopResult {
  readonly status: "queued" | "already_queued";
  readonly instance_id: string;
}

function parse(bytes: Uint8Array, request: boolean): ServeProcessMarker {
  if (bytes.byteLength > 1024) throw new ServeStopError("unsafe");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new ServeStopError("unsafe"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ServeStopError("unsafe");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== (request ? "boot_id,instance_id,pid,schema" : "boot_id,instance_id,pid") ||
    (request && fields.schema !== SCHEMA) || !Number.isSafeInteger(fields.pid) || Number(fields.pid) < 1 ||
    typeof fields.boot_id !== "string" || !fields.boot_id || fields.boot_id.length > 128 ||
    typeof fields.instance_id !== "string" || !UUID.test(fields.instance_id)) throw new ServeStopError("unsafe");
  return { pid: Number(fields.pid), boot_id: fields.boot_id, instance_id: fields.instance_id };
}
function same(a: ServeProcessMarker, b: ServeProcessMarker): boolean {
  return a.pid === b.pid && a.boot_id === b.boot_id && a.instance_id === b.instance_id;
}
function read(files: CanonFiles, path: string, request: boolean): { snapshot: CanonFileSnapshot; marker: ServeProcessMarker } | null {
  const snapshot = files.readPrivate(path);
  if (snapshot === null) return null;
  try { return { snapshot, marker: parse(snapshot.bytes, request) }; }
  catch (error) { snapshot.close(); throw error; }
}
function marker(files: CanonFiles): ServeProcessMarker {
  const value = read(files, MARKER, false);
  if (value === null) throw new ServeStopError("not_running");
  try { return value.marker; } finally { value.snapshot.close(); }
}
function normalize(error: unknown): ServeStopError {
  if (error instanceof ServeStopError) return error;
  if (error instanceof VaultMutationError && error.code === "writer_busy") return new ServeStopError("busy");
  if (error instanceof CanonFilesError) {
    return new ServeStopError(error.reason === "unsupported" || error.reason === "native_unavailable" ? "unavailable" : "unsafe");
  }
  return new ServeStopError("unavailable");
}

function enqueue(root: string): ServeStopResult {
  const check = openCanonFiles(root);
  let initial: ServeProcessMarker;
  try { check.assertPrivateDirectory(".kizuki"); initial = marker(check); } finally { check.close(); }
  const target = { vault_path: root };
  return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, (files): ServeStopResult => {
    files.assertPrivateDirectory(".kizuki");
    const current = marker(files);
    if (!same(initial, current)) throw new ServeStopError("changed");
    const prior = read(files, REQUEST, true);
    let staged: CanonFileSnapshot | null = null;
    try {
      // A complete recognized stage is recoverable; unknown or unsafe material
      // is refused by read() and retained, including symlinks and hardlinks.
      const abandoned = read(files, STAGING, true);
      if (abandoned !== null) files.remove(abandoned.snapshot);
      if (prior !== null && same(prior.marker, current)) return { status: "already_queued", instance_id: current.instance_id };
      staged = files.create(STAGING, Buffer.from(JSON.stringify({ schema: SCHEMA, ...current }) + "\n"));
      if (!same(current, marker(files))) throw new ServeStopError("changed");
      const published = prior === null ? files.publish(staged, REQUEST) : files.replace(staged, prior.snapshot);
      staged = null;
      published.close();
      return { status: "queued", instance_id: current.instance_id };
    } finally {
      // Retain a changed stage instead of unlinking an entry no longer ours.
      if (staged !== null) { try { files.remove(staged); } catch { staged.close(); } }
      prior?.snapshot.close();
    }
  }));
}

/** Queue one exact instance's graceful exit; never infer or signal a PID. */
export async function requestServeStop(vaultPath: string): Promise<ServeStopResult> {
  const root = resolve(vaultPath), deadline = performance.now() + 1000;
  for (;;) {
    try { return enqueue(root); }
    catch (error) {
      const failure = normalize(error);
      if (failure.code !== "busy" || performance.now() >= deadline) throw failure;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** Unverified control data is never interpreted as an instruction to exit. */
export function serveStopRequested(vaultPath: string, own: ServeProcessMarker): boolean {
  let files: CanonFiles | undefined;
  try {
    files = openCanonFiles(vaultPath); files.assertPrivateDirectory(".kizuki");
    const value = read(files, REQUEST, true);
    if (value === null) return false;
    try { return same(value.marker, own); } finally { value.snapshot.close(); }
  } catch { return false; }
  finally { files?.close(); }
}

/** Cleanup cannot displace a successor's request; retained old requests are inert. */
export function clearServeStopRequest(vaultPath: string, own: ServeProcessMarker): void {
  try {
    const check = openCanonFiles(vaultPath);
    try { check.assertPrivateDirectory(".kizuki"); } finally { check.close(); }
    const target = { vault_path: resolve(vaultPath) };
    withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files => {
      files.assertPrivateDirectory(".kizuki");
      for (const path of [REQUEST, STAGING]) {
        const value = read(files, path, true);
        if (value !== null) {
          try { if (same(value.marker, own)) files.remove(value.snapshot); }
          finally { value.snapshot.close(); }
        }
      }
    }));
  } catch { /* Busy or changed control files remain bound to their old instance. */ }
}
