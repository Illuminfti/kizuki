import { sha256Hex } from "../util/hash";

/** Cuts trailing blanks off every line in one pass; a regex with a leading run rescans hostile input. */
function trimLineEnds(unix: string): string {
  const lines = unix.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end !== line.length) lines[i] = line.slice(0, end);
  }
  return lines.join("\n");
}

/** Page metadata is not evidence. Strip an opening frontmatter block without parsing hostile YAML. */
export function machineBodyHash(text: string): string | null {
  const lines = trimLineEnds(text.replace(/\r\n?/g, "\n")).split("\n");
  if (lines[0] === "---") {
    const closing = lines.indexOf("---", 1);
    if (closing !== -1) lines.splice(0, closing + 1);
  }
  const body = lines.join("\n").trim();
  return body.length === 0 ? null : sha256Hex(body);
}

/** Exact images plus linear-time whitespace variants of a copied page. */
export function machineImageHashes(text: string): string[] {
  const unix = text.replace(/\r\n?/g, "\n");
  const forms = new Set([text, unix, trimLineEnds(unix)]);
  const images = new Set<string>();
  for (const form of forms) {
    const trimmed = form.trimEnd();
    // Whitespace alone is never a page; an empty image is the absence sentinel.
    if (trimmed.length === 0) continue;
    images.add(form);
    images.add(trimmed);
    images.add(`${trimmed}\n`);
  }
  return [...images].map(sha256Hex);
}
