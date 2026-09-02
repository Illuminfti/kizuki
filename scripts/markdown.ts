// Bounded Markdown readers for the documentation gate. Pure functions, no I/O
// and no dependency: the gate needs headings, links, fences and pipe tables,
// which is far less than a CommonMark implementation and far easier to trust.

export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface Link {
  target: string;
  line: number;
}

export interface Fence {
  info: string;
  body: string;
  line: number;
  closed: boolean;
}

export interface TableRow {
  cells: string[];
  line: number;
}

export interface Table {
  header: string[];
  rows: TableRow[];
  line: number;
}

export interface Section {
  heading: Heading;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const INLINE_LINK = /\[[^\]\n]*\]\(\s*([^)\s]+)[^)]*\)/g;
const DELIMITER_CELL = /^:?-+:?$/;
// A pipe the author escaped is masked with a sentinel that cannot appear in
// Markdown source, so the split below only sees real cell separators.
const ESCAPED_PIPE = "\u0000";

// GitHub's anchor rule: lowercase, drop everything that is not a letter, a
// digit, a space or a hyphen, then turn spaces into hyphens.
export function slugify(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd} -]/gu, "")
    .replace(/ /g, "-");
}

export function fenceLineNumbers(md: string): Set<number> {
  const lines = md.split("\n");
  const inside = new Set<number>();
  let index = 0;
  while (index < lines.length) {
    const open = FENCE.exec(lines[index] ?? "");
    if (open === null) {
      index += 1;
      continue;
    }
    const marker = open[1] ?? "";
    let cursor = index;
    inside.add(cursor + 1);
    for (cursor = index + 1; cursor < lines.length; cursor += 1) {
      inside.add(cursor + 1);
      if (closesFence(lines[cursor] ?? "", marker)) break;
    }
    index = cursor + 1;
  }
  return inside;
}

export function extractFences(md: string): Fence[] {
  const lines = md.split("\n");
  const fences: Fence[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = FENCE.exec(lines[index] ?? "");
    if (open === null) {
      index += 1;
      continue;
    }
    const marker = open[1] ?? "";
    const body: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (closesFence(line, marker)) {
        closed = true;
        break;
      }
      body.push(line);
    }
    fences.push({
      info: (open[2] ?? "").trim(),
      body: body.join("\n"),
      line: index + 1,
      closed,
    });
    index = cursor + 1;
  }
  return fences;
}

export function extractHeadings(md: string): Heading[] {
  const inside = fenceLineNumbers(md);
  const headings: Heading[] = [];
  md.split("\n").forEach((line, offset) => {
    if (inside.has(offset + 1)) return;
    const match = ATX_HEADING.exec(line);
    if (match === null) return;
    const text = (match[2] ?? "").replace(/`/g, "").trim();
    headings.push({
      level: (match[1] ?? "").length,
      text,
      slug: slugify(text),
      line: offset + 1,
    });
  });
  return headings;
}

export function extractLinks(md: string): Link[] {
  const inside = fenceLineNumbers(md);
  const links: Link[] = [];
  md.split("\n").forEach((line, offset) => {
    if (inside.has(offset + 1)) return;
    const scanned = stripCodeSpans(line);
    INLINE_LINK.lastIndex = 0;
    let match = INLINE_LINK.exec(scanned);
    while (match !== null) {
      const target = match[1];
      if (target !== undefined) links.push({ target, line: offset + 1 });
      match = INLINE_LINK.exec(scanned);
    }
  });
  return links;
}

export function extractTables(md: string): Table[] {
  const lines = md.split("\n");
  const inside = fenceLineNumbers(md);
  const tables: Table[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const header = lines[index] ?? "";
    const delimiter = lines[index + 1] ?? "";
    if (inside.has(index + 1) || !header.includes("|")) continue;
    if (!isDelimiterRow(delimiter)) continue;
    const rows: TableRow[] = [];
    let cursor = index + 2;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (!line.includes("|") || line.trim().length === 0) break;
      if (inside.has(cursor + 1)) break;
      rows.push({ cells: splitRow(line), line: cursor + 1 });
    }
    tables.push({ header: splitRow(header), rows, line: index + 1 });
    index = cursor - 1;
  }
  return tables;
}

export function sections(md: string): Section[] {
  const lines = md.split("\n");
  const found: Section[] = [];
  const headings = extractHeadings(md).filter((heading) => heading.level === 2);
  headings.forEach((heading, position) => {
    const next = headings[position + 1];
    const end = next === undefined ? lines.length : next.line - 1;
    found.push({
      heading,
      text: lines.slice(heading.line - 1, end).join("\n"),
    });
  });
  return found;
}

// Replaces every code span with spaces of the same width so that column
// positions, and therefore line-level regexes, still line up.
export function stripCodeSpans(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      out += line[index];
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") run += 1;
    const marker = "`".repeat(run);
    const close = findClosingRun(line, marker, index + run);
    if (close < 0) {
      out += marker;
      index += run;
      continue;
    }
    const end = close + run;
    out += " ".repeat(end - index);
    index = end;
  }
  return out;
}

function findClosingRun(line: string, marker: string, from: number): number {
  let search = from;
  while (search < line.length) {
    const at = line.indexOf(marker, search);
    if (at < 0) return -1;
    let trailing = 0;
    while (line[at + marker.length + trailing] === "`") trailing += 1;
    if (trailing === 0) return at;
    search = at + marker.length + trailing;
  }
  return -1;
}

function closesFence(line: string, marker: string): boolean {
  const match = FENCE.exec(line);
  if (match === null) return false;
  const candidate = match[1] ?? "";
  return (
    candidate[0] === marker[0] &&
    candidate.length >= marker.length &&
    (match[2] ?? "").trim().length === 0
  );
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function splitRow(line: string): string[] {
  let masked = line.replace(/\\\|/g, ESCAPED_PIPE).trim();
  if (masked.startsWith("|")) masked = masked.slice(1);
  if (masked.endsWith("|")) masked = masked.slice(0, -1);
  return masked
    .split("|")
    .map((cell) => cell.replaceAll(ESCAPED_PIPE, "|").trim());
}
