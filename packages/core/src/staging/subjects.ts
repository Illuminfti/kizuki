/**
 * Connector-scoped subject identity. Page type lives in
 * `subjectPageType` — this module does not infer a second type table.
 */

const SEGMENT_MAX = 64;
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/** Path-safe segment for a connector- or source-local id. */
export function encodeSubjectSegment(value: string): string {
  const cleaned = value.replace(UNSAFE, "-").replace(/^-+|-+$/g, "");
  const started = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `s${cleaned}`;
  const sliced = started.slice(0, SEGMENT_MAX);
  return sliced.length > 0 ? sliced : "subject";
}

/**
 * Global subject identity: connector_id plus encoded source-local id.
 * Display names stay off the id and on frontmatter.
 */
export function namespacedSubjectId(
  connectorId: string,
  subjectId: string,
): string {
  const locals = subjectId
    .split(/[:/]/)
    .filter((part) => part.length > 0)
    .map(encodeSubjectSegment);
  return [encodeSubjectSegment(connectorId), ...locals].slice(0, 8).join("/");
}
