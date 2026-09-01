import { readFileSync } from "node:fs";

interface AttributionFailure {
  path: string;
  line: number;
  column: number;
  reason: string;
}

const delimiter = /[\s<>"'()[\]{}|]/;
const urlContinuation = /[A-Za-z0-9._~:/?#@%&=+,;$!-]/;

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

function schemeStart(text: string, lower: string, offset: number): number | null {
  let tokenStart = offset;
  while (tokenStart > 0 && !delimiter.test(text[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  const tokenPrefix = lower.slice(tokenStart, offset);
  const relative = Math.max(
    tokenPrefix.lastIndexOf("https://"),
    tokenPrefix.lastIndexOf("http://"),
  );
  return relative < 0 ? null : tokenStart + relative;
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

  const lower = text.toLowerCase();
  const failures: AttributionFailure[] = [];
  let offset = 0;
  while ((offset = lower.indexOf(identifier, offset)) >= 0) {
    const urlStart = schemeStart(text, lower, offset);
    let valid = false;

    if (urlStart === null) {
      valid = text.slice(offset, offset + exactSpelling.length) === exactSpelling;
    } else {
      const expectedOffset = urlStart + canonicalUrl.length - identifier.length;
      const candidate = text.slice(urlStart, urlStart + canonicalUrl.length);
      const before = text[urlStart - 1];
      const after = text[urlStart + canonicalUrl.length];
      valid =
        offset === expectedOffset &&
        candidate === canonicalUrl &&
        (before === undefined || !urlContinuation.test(before)) &&
        (after === undefined || !urlContinuation.test(after));
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
    offset += identifier.length;
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
