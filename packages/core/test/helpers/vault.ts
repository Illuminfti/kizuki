import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializePage } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";

export function tempVault(prefix = "kizuki-vault-"): {
  path: string;
  dispose: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), prefix));
  initVault(path);
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function writeCanon(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): void {
  writeFileSync(join(vaultPath, relPath), serializePage({ data, body }), "utf8");
}
