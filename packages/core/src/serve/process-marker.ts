import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVE_PID_PATH } from "./types";

export function servePidPath(vaultPath: string): string {
  return join(vaultPath, SERVE_PID_PATH);
}

export interface ServeProcessMarker { pid: number; boot_id: string; instance_id: string; }
export function readServeProcessMarker(vaultPath: string): ServeProcessMarker | null {
  const path = servePidPath(vaultPath);
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4096) return null;
    const raw = readFileSync(fd, "utf8");
    if (raw.length > 4096) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if (Object.keys(marker).sort().join() !== "boot_id,instance_id,pid" || !Number.isSafeInteger(marker.pid) || Number(marker.pid) < 1 || typeof marker.boot_id !== "string" || !marker.boot_id || marker.boot_id.length > 128 || typeof marker.instance_id !== "string" || !marker.instance_id || marker.instance_id.length > 128) return null;
    return marker as unknown as ServeProcessMarker;
  } finally { closeSync(fd); }
}
export function readServePid(vaultPath: string): number | null {
  const marker = readServeProcessMarker(vaultPath);
  if (marker) return marker.pid;
  const path = servePidPath(vaultPath);
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4096) return null;
    const raw = readFileSync(fd, "utf8").trim();
    if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
  } finally { closeSync(fd); }
}
