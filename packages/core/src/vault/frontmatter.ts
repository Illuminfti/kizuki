export interface VaultPage {
  data: Record<string, unknown>;
  body: string;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function parseDoubleQuoted(raw: string, key: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // The error below carries the frontmatter key, unlike JSON.parse.
  }
  throw new SyntaxError(`${key}: invalid double-quoted string`);
}

function parseSingleQuoted(raw: string, key: string): string {
  if (raw.length < 2 || !raw.endsWith("'")) {
    throw new SyntaxError(`${key}: invalid single-quoted string`);
  }
  const inner = raw.slice(1, -1);
  let parsed = "";
  for (let i = 0; i < inner.length; i += 1) {
    const character = inner[i];
    if (character !== "'") {
      parsed += character;
      continue;
    }
    if (inner[i + 1] !== "'") {
      throw new SyntaxError(`${key}: single quotes must be doubled`);
    }
    parsed += "'";
    i += 1;
  }
  return parsed;
}

function splitInlineArray(inner: string, key: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < inner.length; i += 1) {
    const character = inner[i];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && inner[i + 1] === "'") {
        i += 1;
      } else if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ",") {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }

  if (quote !== undefined || escaped) {
    throw new SyntaxError(`${key}: unterminated quoted array item`);
  }
  parts.push(inner.slice(start));
  return parts;
}

function parseArrayItem(raw: string, key: string): string {
  const item = raw.trim();
  if (item.length === 0) {
    throw new SyntaxError(`${key}: array items must be non-empty strings`);
  }
  if (item.startsWith("\"")) return parseDoubleQuoted(item, key);
  if (item.startsWith("'")) return parseSingleQuoted(item, key);
  if (item.endsWith("\"") || item.endsWith("'")) {
    throw new SyntaxError(`${key}: invalid quoted array item`);
  }
  if (item === "true" || item === "false" || NUMBER.test(item)) {
    throw new SyntaxError(`${key}: arrays may contain only strings`);
  }
  return item;
}

function parseInlineArray(raw: string, key: string): string[] {
  if (!raw.endsWith("]")) {
    throw new SyntaxError(`${key}: unterminated inline array`);
  }
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitInlineArray(inner, key).map((item) => parseArrayItem(item, key));
}

function parseValue(raw: string, key: string): string | number | boolean | string[] {
  if (raw.startsWith("\"")) return parseDoubleQuoted(raw, key);
  if (raw.startsWith("'")) return parseSingleQuoted(raw, key);
  if (raw.startsWith("[")) return parseInlineArray(raw, key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (NUMBER.test(raw)) {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return raw;
}

export function parseFrontmatter(markdown: string): VaultPage {
  const opening = /^---(?:\r\n|\n)/.exec(markdown);
  if (opening === null) {
    throw new SyntaxError("frontmatter must begin with an exact --- line");
  }

  const remainder = markdown.slice(opening[0].length);
  const closing = /^---(?:\r\n|\n|$)/m.exec(remainder);
  if (closing === null) {
    throw new SyntaxError("frontmatter must end with an exact --- line");
  }

  const data: Record<string, unknown> = {};
  const frontmatter = remainder.slice(0, closing.index);
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new SyntaxError(`frontmatter line ${index + 1}: expected key: value`);
    }
    const key = line.slice(0, separator).trim();
    if (!KEY.test(key)) {
      throw new SyntaxError(`frontmatter line ${index + 1}: invalid key "${key}"`);
    }
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new SyntaxError(`${key}: duplicate frontmatter key`);
    }
    Object.defineProperty(data, key, {
      value: parseValue(line.slice(separator + 1).trim(), key),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    data,
    body: remainder.slice(closing.index + closing[0].length),
  };
}

function serializeValue(value: unknown, key: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return JSON.stringify(value);
  }
  throw new TypeError(
    `${key}: frontmatter values must be strings, finite numbers, booleans, or string arrays`,
  );
}

export function serializePage(page: VaultPage): string {
  if (typeof page.body !== "string") {
    throw new TypeError("page body must be a string");
  }
  const lines = ["---"];
  for (const [key, value] of Object.entries(page.data)) {
    if (!KEY.test(key)) throw new TypeError(`invalid frontmatter key "${key}"`);
    lines.push(`${key}: ${serializeValue(value, key)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${page.body}`;
}
