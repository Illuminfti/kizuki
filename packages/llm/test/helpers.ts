import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "@kizuki/core";

export function tempVault(): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), "kizuki-llm-"));
  initVault(path);
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}
