/** Loop-written pages live here so extraction cannot treat them as human canon (RFC 0002 E8). */
export const AUTO_CANON_PREFIX = "auto";

export function isMachineOriginPath(relPath: string): boolean {
  return relPath === AUTO_CANON_PREFIX || relPath.startsWith(`${AUTO_CANON_PREFIX}/`);
}

/** Prefix a create-path. Edits of an existing human page stay put. */
export function machineOriginPath(relPath: string): string {
  if (isMachineOriginPath(relPath)) return relPath;
  return `${AUTO_CANON_PREFIX}/${relPath}`;
}
