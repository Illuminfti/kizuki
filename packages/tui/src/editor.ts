import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export function pickEditor(env: Record<string, string | undefined>): string | null {
  for (const name of ["VISUAL", "EDITOR"]) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  for (const candidate of ["vim", "nano", "vi"]) {
    if (Bun.which(candidate) !== null) return candidate;
  }
  return null;
}

/** Opens text in the owner's editor and returns what they saved. */
export function editInEditor(editor: string, body: string, id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-audit-"));
  const file = join(dir, `${id}.md`);
  try {
    writeFileSync(file, body, "utf8");
    const argv = [...editor.split(/\s+/).filter((token) => token.length > 0), file];
    const result = Bun.spawnSync(argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`${basename(argv[0] ?? editor)} exited with ${result.exitCode}`);
    }
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
