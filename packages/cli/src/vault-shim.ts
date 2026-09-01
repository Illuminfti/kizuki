// integration: replace with core vault module
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { isRfc3339 } from "@kizuki/core";

export const PAGE_TYPES = ["note", "entity", "claim"] as const;
export const SENSITIVITIES = ["public", "personal", "private"] as const;

export type PageType = (typeof PAGE_TYPES)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];

export interface PageInput {
  body: string;
  createdAt: string;
  id: string;
  sensitivity: Sensitivity;
  sources: string[];
  type: PageType;
}

export interface CanonPage {
  body: string;
  id: string;
  path: string;
}

interface ParsedPage {
  attributes: Record<string, string | string[]>;
  body: string;
  problems: string[];
}

export function isSensitivity(value: string): value is Sensitivity {
  return (SENSITIVITIES as readonly string[]).includes(value);
}

export function initVault(vaultPath: string): string {
  const absolutePath = resolve(vaultPath);
  mkdirSync(join(absolutePath, ".kizuki"), { recursive: true });
  mkdirSync(join(absolutePath, "canon"), { recursive: true });
  return absolutePath;
}

export function assertVault(vaultPath: string): string {
  const absolutePath = resolve(vaultPath);
  if (
    !existsSync(join(absolutePath, ".kizuki")) ||
    !existsSync(join(absolutePath, "canon"))
  ) {
    throw new Error(`vault is not initialized: ${absolutePath}`);
  }
  return absolutePath;
}

export function writePage(vaultPath: string, page: PageInput): string {
  const absolutePath = assertVault(vaultPath);
  if (!(PAGE_TYPES as readonly string[]).includes(page.type)) {
    throw new Error(`invalid page type: ${page.type}`);
  }
  if (!isSensitivity(page.sensitivity)) {
    throw new Error(`invalid sensitivity: ${page.sensitivity}`);
  }
  if (page.sources.length === 0 || page.sources.some((source) => source === "")) {
    throw new Error("page sources must be non-empty");
  }
  if (page.id === "" || !isRfc3339(page.createdAt)) {
    throw new Error("page id and RFC3339 created_at are required");
  }

  const frontmatter = [
    "---",
    `type: ${page.type}`,
    `sensitivity: ${page.sensitivity}`,
    "sources:",
    ...page.sources.map((source) => `  - ${source}`),
    `id: ${page.id}`,
    `created_at: ${page.createdAt}`,
    "---",
    "",
  ].join("\n");
  const path = join(absolutePath, "canon", `${page.id}.md`);
  writeFileSync(path, `${frontmatter}${page.body.trimEnd()}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return path;
}

function parsePage(content: string): ParsedPage {
  const lines = content.split(/\r?\n/);
  const problems: string[] = [];
  if (lines[0] !== "---") {
    return { attributes: {}, body: "", problems: ["missing frontmatter"] };
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    return {
      attributes: {},
      body: "",
      problems: ["unterminated frontmatter"],
    };
  }

  const attributes: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const line of lines.slice(1, closing)) {
    const listItem = /^  - (.+)$/.exec(line);
    if (listItem !== null) {
      if (listKey === undefined) {
        problems.push("list item without a key");
        continue;
      }
      const current = attributes[listKey];
      if (!Array.isArray(current)) {
        problems.push(`invalid list ${listKey}`);
        continue;
      }
      current.push(listItem[1] ?? "");
      continue;
    }

    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    if (field === null) {
      problems.push(`invalid frontmatter line: ${line}`);
      listKey = undefined;
      continue;
    }
    const key = field[1] ?? "";
    if (key in attributes) {
      problems.push(`duplicate frontmatter key: ${key}`);
      listKey = undefined;
      continue;
    }
    const value = field[2];
    if (value === undefined) {
      attributes[key] = [];
      listKey = key;
    } else {
      attributes[key] = value;
      listKey = undefined;
    }
  }

  return {
    attributes,
    body: lines.slice(closing + 1).join("\n").replace(/^\r?\n/, ""),
    problems,
  };
}

function validateParsedPage(parsed: ParsedPage): string[] {
  const problems = [...parsed.problems];
  const type = parsed.attributes["type"];
  if (typeof type !== "string" || !(PAGE_TYPES as readonly string[]).includes(type)) {
    problems.push("type is missing or invalid");
  }
  const sensitivity = parsed.attributes["sensitivity"];
  if (typeof sensitivity !== "string" || !isSensitivity(sensitivity)) {
    problems.push("sensitivity is missing or invalid");
  }
  const sources = parsed.attributes["sources"];
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((source) => source === "")
  ) {
    problems.push("sources are missing or empty");
  }
  const id = parsed.attributes["id"];
  if (typeof id !== "string" || id === "") {
    problems.push("id is missing");
  }
  if (!isRfc3339(parsed.attributes["created_at"])) {
    problems.push("created_at is missing or invalid");
  }
  return problems;
}

function markdownFiles(vaultPath: string): string[] {
  const canonPath = join(assertVault(vaultPath), "canon");
  return readdirSync(canonPath)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(canonPath, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

export function doctor(vaultPath: string): string[] {
  const problems: string[] = [];
  for (const path of markdownFiles(vaultPath)) {
    const parsed = parsePage(readFileSync(path, "utf8"));
    for (const problem of validateParsedPage(parsed)) {
      problems.push(`${basename(path)}: ${problem}`);
    }
  }
  return problems;
}

export function readCanonPages(vaultPath: string): CanonPage[] {
  const pages: CanonPage[] = [];
  for (const path of markdownFiles(vaultPath)) {
    const parsed = parsePage(readFileSync(path, "utf8"));
    if (validateParsedPage(parsed).length > 0) continue;
    const id = parsed.attributes["id"];
    if (typeof id === "string") pages.push({ body: parsed.body, id, path });
  }
  return pages;
}
