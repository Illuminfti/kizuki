import { sha256Hex } from "../util/hash";

/**
 * A copy of a machine-written page is still that page. Registered bytes are
 * exact, so a copy that only changed line endings, trailing whitespace or the
 * final newline would otherwise pass as external evidence.
 * These are the images such a copy could have been derived from.
 */
export function machineImageHashes(text: string): string[] {
  const unix = text.replace(/\r\n?/g, "\n");
  const forms = new Set([text, unix, unix.replace(/[ \t]+$/gm, "")]);
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
