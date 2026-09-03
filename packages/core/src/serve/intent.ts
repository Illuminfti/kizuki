import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SERVE_INTENT_PATH, isServeIntent, type ServeIntent } from "./types";

export function serveIntentPath(vaultPath: string): string {
  return join(vaultPath, SERVE_INTENT_PATH);
}

export function readServeIntent(vaultPath: string): ServeIntent {
  const path = serveIntentPath(vaultPath);
  if (!existsSync(path)) return "none";
  const value = readFileSync(path, "utf8").trim();
  return isServeIntent(value) ? value : "none";
}

export function writeServeIntent(vaultPath: string, intent: ServeIntent): void {
  const path = serveIntentPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${intent}\n`, { mode: 0o600 });
}
