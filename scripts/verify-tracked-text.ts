const publicRepository = "https://github.com/Illuminfti/kizuki";
const ownerOffset = "https://github.com/".length;
const delimiter = /[\s<>"'()[\]{}|`]/u;

function publicOwnerOccurrence(text: string, offset: number): boolean {
  const start = offset - ownerOffset;
  if (start < 0 || text.slice(start, start + publicRepository.length) !== publicRepository) return false;
  const before = text[start - 1];
  const after = text[start + publicRepository.length];
  // Exact spelling only. The exception ends at the owner occurrence; paths,
  // queries, fragments and the rest of the line retain the full denylist.
  return (before === undefined || delimiter.test(before)) &&
    (after === undefined || delimiter.test(after) || after === "/" || after === "?" || after === "#");
}

/** Parse git grep -n -z records without confusing newlines in tracked paths. */
function scanTrackedText(records: string, identifierPattern: string): string[] {
  if (records.length === 0) throw new Error("empty tracked-text producer output");
  const pattern = new RegExp(identifierPattern, "giu");
  const failures: string[] = [];
  let offset = 0;
  while (offset < records.length) {
    const pathEnd = records.indexOf("\0", offset);
    const lineEnd = records.indexOf("\0", pathEnd + 1);
    const textEnd = records.indexOf("\n", lineEnd + 1);
    if (pathEnd < offset || lineEnd <= pathEnd || textEnd <= lineEnd) throw new Error("malformed tracked-text producer record");
    const path = records.slice(offset, pathEnd);
    const line = records.slice(pathEnd + 1, lineEnd);
    const text = records.slice(lineEnd + 1, textEnd);
    if (path.length === 0 || !/^[1-9][0-9]*$/.test(line) || text.includes("\0")) throw new Error("malformed tracked-text producer record");
    if ([...text.matchAll(pattern)].some(match => !publicOwnerOccurrence(text, match.index))) {
      failures.push(`${JSON.stringify(path)}:${line}: forbidden identifier`);
    }
    offset = textEnd + 1;
  }
  return failures;
}

if (import.meta.main) {
  try {
    const pattern = process.argv[2];
    if (pattern === undefined || pattern.length === 0) throw new Error("tracked-text identifier pattern is required");
    const failures = scanTrackedText(await Bun.stdin.text(), pattern);
    if (failures.length > 0) {
      console.error(`verification failed: forbidden identifier in tracked text matched\n${failures.join("\n")}`);
      process.exitCode = 1;
    }
  } catch {
    console.error("verification failed: tracked-text validator could not read producer records");
    process.exitCode = 2;
  }
}
