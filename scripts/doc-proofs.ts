// Proof tokens are the traceability contract: a documentation row may claim
// something only if it names a tracked file, a literal test title inside that
// file, or a command this repository can actually run.

export interface ProofToken {
  raw: string;
  kind: "file" | "run";
  path: string | null;
  needle: string | null;
  command: string | null;
}

export interface DocsContext {
  tracked: Set<string>;
  readFile(path: string): string | null;
  scripts: Set<string>;
}

const RUN_SCRIPT = /^bun run ([A-Za-z0-9:_-]+)$/;
const RUN_BASH_SCRIPT = /^bash (scripts\/[^\s]+)(?:\s.*)?$/;
const RUN_BUN_SCRIPT = /^bun (scripts\/[^\s]+)(?:\s.*)?$/;
const RUN_BUN_PACKAGE = /^bun (packages\/[^/\s]+\/src\/[^\s]+)(?:\s.*)?$/;

export function parseProofTokens(cell: string): ProofToken[] {
  const tokens: ProofToken[] = [];
  const pattern = /`([^`]+)`/g;
  let match = pattern.exec(cell);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw.startsWith("run: ")) {
      tokens.push({
        raw,
        kind: "run",
        path: null,
        needle: null,
        command: raw.slice("run: ".length).trim(),
      });
    } else {
      const separator = raw.indexOf("::");
      tokens.push({
        raw,
        kind: "file",
        path: separator < 0 ? raw : raw.slice(0, separator),
        needle: separator < 0 ? null : raw.slice(separator + 2),
        command: null,
      });
    }
    match = pattern.exec(cell);
  }
  return tokens;
}

export function checkProof(token: ProofToken, ctx: DocsContext): string | null {
  if (token.kind === "run") return checkRunProof(token.command ?? "", ctx);
  const path = token.path ?? "";
  if (!ctx.tracked.has(path)) return `proof path is not tracked: ${path}`;
  if (token.needle === null) return null;
  const content = ctx.readFile(path);
  if (content === null) return `proof file cannot be read: ${path}`;
  if (!content.includes(token.needle)) {
    return `proof needle is absent from ${path}: ${token.needle}`;
  }
  return null;
}

function checkRunProof(command: string, ctx: DocsContext): string | null {
  const script = RUN_SCRIPT.exec(command);
  if (script !== null) {
    const name = script[1] ?? "";
    return ctx.scripts.has(name)
      ? null
      : `proof names a script that does not exist: ${name}`;
  }
  for (const pattern of [RUN_BASH_SCRIPT, RUN_BUN_SCRIPT, RUN_BUN_PACKAGE]) {
    const match = pattern.exec(command);
    if (match === null) continue;
    const path = match[1] ?? "";
    return ctx.tracked.has(path)
      ? null
      : `proof runs a file that is not tracked: ${path}`;
  }
  return `proof command is not a permitted form: ${command}`;
}
