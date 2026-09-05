import { dirname, join } from "node:path";
import { SERVE_INTENT_PATH, isServeIntent, type ServeIntent } from "./types";
import { replaceServiceFile, serviceDirectory, serviceFile } from "./service-files";

export function serveIntentPath(vaultPath: string): string {
  return join(vaultPath, SERVE_INTENT_PATH);
}

export function readServeIntent(vaultPath: string): ServeIntent {
  const path = serveIntentPath(vaultPath);
  const value = serviceFile(path)?.trim() ?? "none";
  if (!isServeIntent(value)) throw new Error("service intent is invalid");
  return value;
}

export function writeServeIntent(vaultPath: string, intent: ServeIntent): void {
  const path = serveIntentPath(vaultPath);
  serviceDirectory(vaultPath, dirname(path));
  replaceServiceFile(path, `${intent}\n`);
}
