import { readFileSync } from "node:fs";

interface AttributionFailure {
  path: string;
  line: number;
  column: number;
  reason: string;
}

const delimiter = /[\s<>"'()[\]{}|]/;
const tokenCharacter = /[\p{L}\p{N}\p{M}\p{Pc}\u200C\u200D]/u;
const urlContinuation = /[\p{L}\p{N}\p{M}._~:/?#@%&=+,;$!-]/u;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function location(text: string, offset: number): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const line = prefix.split("\n").length;
  const lastNewline = prefix.lastIndexOf("\n");
  return { line, column: offset - lastNewline };
}

function schemeStart(text: string, offset: number): number | null {
  let tokenStart = offset;
  while (tokenStart > 0 && !delimiter.test(text[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  const tokenPrefix = text.slice(tokenStart, offset);
  const relative = Math.max(
    tokenPrefix.lastIndexOf("https://"),
    tokenPrefix.lastIndexOf("http://"),
  );
  return relative < 0 ? null : tokenStart + relative;
}

function literalPattern(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function characterBefore(text: string, offset: number): string | undefined {
  if (offset === 0) return undefined;
  const lastCodeUnit = text.charCodeAt(offset - 1);
  const start =
    lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && offset > 1
      ? offset - 2
      : offset - 1;
  return text.slice(start, offset);
}

function characterAt(text: string, offset: number): string | undefined {
  const codePoint = text.codePointAt(offset);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function hasTokenBoundaries(text: string, offset: number, length: number): boolean {
  return (
    !tokenCharacter.test(characterBefore(text, offset) ?? "") &&
    !tokenCharacter.test(characterAt(text, offset + length) ?? "")
  );
}

export function validateAttributionText(
  path: string,
  text: string,
  exactSpelling: string,
  canonicalUrl: string,
): AttributionFailure[] {
  const identifier = exactSpelling.toLowerCase();
  if (!canonicalUrl.toLowerCase().endsWith(identifier)) {
    throw new Error("canonical URL must end with the attribution identifier");
  }

  const failures: AttributionFailure[] = [];
  let hasExactCredit = false;
  let hasCanonicalUrl = false;
  for (const match of text.matchAll(literalPattern(exactSpelling))) {
    const offset = match.index;
    if (offset === undefined) continue;
    const urlStart = schemeStart(text, offset);
    let valid = false;

    if (urlStart === null) {
      valid =
        text.slice(offset, offset + exactSpelling.length) === exactSpelling &&
        hasTokenBoundaries(text, offset, exactSpelling.length);
      hasExactCredit ||= valid;
    } else {
      const expectedOffset = urlStart + canonicalUrl.length - identifier.length;
      const candidate = text.slice(urlStart, urlStart + canonicalUrl.length);
      const before = characterBefore(text, urlStart);
      const after = characterAt(text, urlStart + canonicalUrl.length);
      valid =
        offset === expectedOffset &&
        candidate === canonicalUrl &&
        (before === undefined || !urlContinuation.test(before)) &&
        (after === undefined || !urlContinuation.test(after));
      hasCanonicalUrl ||= valid;
    }

    if (!valid) {
      const point = location(text, offset);
      failures.push({
        path,
        ...point,
        reason: urlStart === null
          ? "public attribution does not use the exact spelling"
          : "public attribution URL is not the exact delimited canonical URL",
      });
    }
  }
  if (!hasExactCredit) {
    failures.push({
      path,
      line: 1,
      column: 1,
      reason: "public attribution is missing the exact credit",
    });
  }
  if (!hasCanonicalUrl) {
    failures.push({
      path,
      line: 1,
      column: 1,
      reason: "public attribution is missing the canonical URL",
    });
  }
  return failures;
}

async function main(): Promise<void> {
  const exactSpelling = requiredEnvironment("ATTRIBUTION_EXACT_SPELLING");
  const canonicalUrl = requiredEnvironment("ATTRIBUTION_CANONICAL_URL");
  const paths = new TextDecoder()
    .decode(await Bun.stdin.arrayBuffer())
    .split("\0")
    .filter((path) => path.length > 0);

  const failures = paths.flatMap((path) =>
    validateAttributionText(
      path,
      readFileSync(path, "utf8"),
      exactSpelling,
      canonicalUrl,
    ),
  );
  for (const failure of failures) {
    console.error(
      `${failure.path}:${failure.line}:${failure.column}: ${failure.reason}`,
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
