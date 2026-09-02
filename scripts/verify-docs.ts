// Documentation gate. Every claim in the shipped Markdown must be traceable:
// links resolve to tracked files, anchors resolve to real headings, diagrams
// are the bounded dialect GitHub renders, and every row of a Proof table names
// a test or a command that exists on this revision.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  extractFences,
  extractHeadings,
  extractLinks,
  extractTables,
  fenceLineNumbers,
  sections,
} from "./markdown";
import type { Table } from "./markdown";

export interface DocProblem {
  file: string;
  line: number;
  reason: string;
}

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

export interface DocsReport {
  files: string[];
  links: number;
  anchors: number;
  proofs: number;
  mermaid: number;
  problems: DocProblem[];
}

export const CHECKED_EXTENSION = ".md" as const;

// The wave-1 lane specs and plan are a frozen internal archive written before
// this gate existed. They are working papers, not shipped documentation.
export const EXCLUDED_PREFIXES = ["docs/wave1/"] as const;

export const STATUS_HEADINGS = [
  "What runs today",
  "Accepted design",
  "Direction",
] as const;

export const HONESTY_FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/connectors.md",
] as const;

export const FORBIDDEN_PHRASES = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bFIXME\b/,
  /coming soon/i,
] as const;

export const MERMAID_FIRST_LINE =
  /^(flowchart|graph)\s+(LR|RL|TB|TD|BT)\b|^(sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram)\b/;

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

interface Counts {
  links: number;
  anchors: number;
  proofs: number;
  mermaid: number;
}

interface Inspection {
  problems: DocProblem[];
  counts: Counts;
}

export function checkDocument(
  file: string,
  md: string,
  ctx: DocsContext,
): DocProblem[] {
  return inspectDocument(file, md, ctx).problems;
}

function inspectDocument(
  file: string,
  md: string,
  ctx: DocsContext,
): Inspection {
  const problems: DocProblem[] = [];
  const counts: Counts = { links: 0, anchors: 0, proofs: 0, mermaid: 0 };
  const report = (line: number, reason: string): void => {
    problems.push({ file, line, reason });
  };

  checkLinks(file, md, ctx, counts, report);
  checkFences(file, md, counts, report);
  const tables = extractTables(md);
  checkProofTables(tables, ctx, counts, report);
  if (file === "README.md") checkReadmeStatus(md, report);
  if ((HONESTY_FILES as readonly string[]).includes(file)) {
    checkHonesty(md, report);
  }
  return { problems, counts };
}

function checkLinks(
  file: string,
  md: string,
  ctx: DocsContext,
  counts: Counts,
  report: (line: number, reason: string) => void,
): void {
  const ownSlugs = new Set(extractHeadings(md).map((heading) => heading.slug));
  for (const link of extractLinks(md)) {
    counts.links += 1;
    const { target, line } = link;
    if (target.startsWith("http://")) {
      report(line, `insecure link: ${target}`);
      continue;
    }
    if (target.startsWith("https://") || target.startsWith("mailto:")) continue;
    if (target.startsWith("#")) {
      counts.anchors += 1;
      if (!ownSlugs.has(target.slice(1))) {
        report(line, `link anchor matches no heading here: ${target}`);
      }
      continue;
    }
    const hash = target.indexOf("#");
    const rawPath = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? null : target.slice(hash + 1);
    const resolved = resolveTarget(file, rawPath);
    if (resolved === null) {
      report(line, `link escapes the repository: ${target}`);
      continue;
    }
    if (!ctx.tracked.has(resolved) && !isTrackedDirectory(resolved, ctx)) {
      report(line, `link target is not tracked: ${target}`);
      continue;
    }
    if (anchor === null) continue;
    counts.anchors += 1;
    if (!resolved.endsWith(CHECKED_EXTENSION)) continue;
    const content = ctx.readFile(resolved);
    if (content === null) {
      report(line, `link target cannot be read: ${resolved}`);
      continue;
    }
    const slugs = new Set(extractHeadings(content).map((h) => h.slug));
    if (!slugs.has(anchor)) {
      report(line, `link anchor matches no heading in ${resolved}: #${anchor}`);
    }
  }
}

function checkFences(
  file: string,
  md: string,
  counts: Counts,
  report: (line: number, reason: string) => void,
): void {
  for (const fence of extractFences(md)) {
    if (!fence.closed) {
      report(fence.line, "unclosed code fence");
      continue;
    }
    if (!fence.info.startsWith("mermaid")) continue;
    counts.mermaid += 1;
    const first = fence.body
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (first === undefined || !MERMAID_FIRST_LINE.test(first)) {
      report(fence.line, `mermaid first line is not a supported diagram type`);
    }
    if (fence.body.includes("%%{")) {
      report(fence.line, "mermaid init directive is not allowed");
    }
    if (/(^|\s)click\s/.test(fence.body) || fence.body.includes("href")) {
      report(fence.line, "mermaid click or href is not allowed");
    }
    if (/<\/?[a-z]/i.test(fence.body)) {
      report(fence.line, "mermaid label contains HTML");
    }
    if (fence.body.includes("\t")) {
      report(fence.line, "mermaid body contains a tab");
    }
    if (!subgraphsBalance(fence.body)) {
      report(fence.line, "mermaid subgraph and end lines do not balance");
    }
  }
}

function subgraphsBalance(body: string): boolean {
  let depth = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("subgraph")) depth += 1;
    else if (trimmed === "end") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function checkProofTables(
  tables: Table[],
  ctx: DocsContext,
  counts: Counts,
  report: (line: number, reason: string) => void,
): void {
  for (const table of tables) {
    const column = table.header.indexOf("Proof");
    if (column < 0) continue;
    for (const row of table.rows) {
      const cell = row.cells[column] ?? "";
      const tokens = parseProofTokens(cell);
      if (tokens.length === 0) {
        report(row.line, "table row carries no proof token");
        continue;
      }
      for (const token of tokens) {
        counts.proofs += 1;
        const reason = checkProof(token, ctx);
        if (reason !== null) report(row.line, reason);
      }
    }
  }
}

function checkReadmeStatus(
  md: string,
  report: (line: number, reason: string) => void,
): void {
  const found = sections(md);
  const positions = STATUS_HEADINGS.map((title) =>
    found.findIndex((section) => section.heading.text === title),
  );
  STATUS_HEADINGS.forEach((title, index) => {
    if (positions[index] === -1) {
      report(1, `README is missing the H2 heading: ${title}`);
    }
  });
  const present = positions.filter((position) => position >= 0);
  const ordered = [...present].sort((a, b) => a - b);
  if (present.join(",") !== ordered.join(",")) {
    report(1, "README status headings are out of order");
  }
  const runs = found.find(
    (section) => section.heading.text === STATUS_HEADINGS[0],
  );
  if (runs === undefined) return;
  for (const table of extractTables(runs.text)) {
    if (table.header.includes("Proof")) continue;
    report(
      runs.heading.line + table.line - 1,
      "table under What runs today has no Proof column",
    );
  }
}

function checkHonesty(
  md: string,
  report: (line: number, reason: string) => void,
): void {
  const inside = fenceLineNumbers(md);
  md.split("\n").forEach((line, offset) => {
    if (inside.has(offset + 1)) return;
    for (const phrase of FORBIDDEN_PHRASES) {
      if (phrase.test(line)) {
        report(
          offset + 1,
          `placeholder phrase in shipped prose: ${phrase.source}`,
        );
      }
    }
  });
}

function resolveTarget(file: string, target: string): string | null {
  if (target.length === 0) return null;
  if (target.startsWith("/")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(file), target));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined.replace(/\/$/, "");
}

function isTrackedDirectory(path: string, ctx: DocsContext): boolean {
  const prefix = `${path}/`;
  for (const tracked of ctx.tracked) {
    if (tracked.startsWith(prefix)) return true;
  }
  return false;
}

export function isCheckedFile(path: string): boolean {
  if (!path.endsWith(CHECKED_EXTENSION)) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultContext(root: string): DocsContext {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (!listed.success) throw new Error("git ls-files failed");
  const tracked = new Set(
    new TextDecoder()
      .decode(listed.stdout)
      .split("\0")
      .filter((path) => path.length > 0),
  );
  const scripts = new Set<string>();
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  if (isRecord(manifest) && isRecord(manifest["scripts"])) {
    for (const name of Object.keys(manifest["scripts"])) scripts.add(name);
  }
  const cache = new Map<string, string | null>();
  return {
    tracked,
    scripts,
    readFile(path: string): string | null {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      let content: string | null = null;
      try {
        content = readFileSync(join(root, path), "utf8");
      } catch {
        content = null;
      }
      cache.set(path, content);
      return content;
    },
  };
}

export function verifyDocs(root: string, ctx?: DocsContext): DocsReport {
  const context = ctx ?? defaultContext(root);
  const files = [...context.tracked].filter(isCheckedFile).sort();
  const report: DocsReport = {
    files,
    links: 0,
    anchors: 0,
    proofs: 0,
    mermaid: 0,
    problems: [],
  };
  for (const file of files) {
    const content = context.readFile(file);
    if (content === null) {
      report.problems.push({ file, line: 1, reason: "file cannot be read" });
      continue;
    }
    const inspection = inspectDocument(file, content, context);
    report.problems.push(...inspection.problems);
    report.links += inspection.counts.links;
    report.anchors += inspection.counts.anchors;
    report.proofs += inspection.counts.proofs;
    report.mermaid += inspection.counts.mermaid;
  }
  return report;
}

if (import.meta.main) {
  const report = verifyDocs(process.cwd());
  for (const problem of report.problems) {
    console.error(`${problem.file}:${problem.line}: ${problem.reason}`);
  }
  if (report.problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `documentation verification passed (${report.files.length} files, ${report.links} links, ${report.anchors} anchors, ${report.proofs} proofs, ${report.mermaid} mermaid fences)`,
    );
  }
}
