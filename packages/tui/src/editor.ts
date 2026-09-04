import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Split an editor command into argv without a shell. Supports single and
 * double quotes so a path with spaces stays one argument.
 */
export function parseEditorCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if ((quote === '"' || quote === null) && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped || quote !== null) {
    throw new Error("editor command has an unclosed quote");
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("editor command is empty");
  }
  return tokens;
}

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

export type EditorArgv = string | readonly string[];

function editorArgv(editor: EditorArgv): string[] {
  return typeof editor === "string" ? parseEditorCommand(editor) : [...editor];
}

/** Opens text in the owner's editor and returns what they saved. */
export function editInEditor(editor: EditorArgv, body: string, id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-audit-"));
  const file = join(dir, `${id}.md`);
  try {
    writeFileSync(file, body, "utf8");
    const argv = [...editorArgv(editor), file];
    const result = Bun.spawnSync(argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`${basename(argv[0] ?? "editor")} exited with ${result.exitCode}`);
    }
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
