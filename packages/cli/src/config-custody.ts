import { lstatSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./runtime";

/**
 * Model configuration is read only from a serve.toml with mode exactly 600. A
 * looser file makes inspection fail closed with no reason, so name the fix.
 */
export function serveTomlModeHint(vaultPath: string): string | null {
  const path = join(vaultPath, ".kizuki", "serve.toml");
  let mode: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    mode = stat.mode & 0o777;
  } catch { return null; }
  if (mode === 0o600) return null;
  return `${path} has mode ${mode.toString(8)} but model configuration is read only when it is 600. Run: chmod 600 ${shellQuote(path)}`;
}
