const DAEMON_BRIEF_PATH = /^dashboards\/brief-\d{4}-\d{2}-\d{2}\.md$/;

/** Loop-written pages live here so extraction cannot treat them as human canon (RFC 0002 E8). */
export const AUTO_CANON_PREFIX = "auto";

/** The daily brief the serve loop writes into `dashboards/` (`serve/notifier-file.ts`). */
export function isDaemonBriefPath(relPath: string): boolean {
  return DAEMON_BRIEF_PATH.test(relPath);
}

function underAutoPrefix(relPath: string): boolean {
  return relPath === AUTO_CANON_PREFIX || relPath.startsWith(`${AUTO_CANON_PREFIX}/`);
}

/** Pages the loop wrote itself: everything under `auto/` and the daily briefs. */
export function isMachineOriginPath(relPath: string): boolean {
  return underAutoPrefix(relPath) || isDaemonBriefPath(relPath);
}

/** Prefix a create-path. Edits of an existing human page stay put. */
export function machineOriginPath(relPath: string): string {
  if (underAutoPrefix(relPath)) return relPath;
  return `${AUTO_CANON_PREFIX}/${relPath}`;
}

/**
 * SQL twin of `isMachineOriginPath` for a relative-path column. `column` MUST
 * be a column reference: it is substituted several times.
 */
export function machineOriginSql(column: string): string {
  return (
    `(${column} = '${AUTO_CANON_PREFIX}' OR ${column} GLOB '${AUTO_CANON_PREFIX}/*'` +
    ` OR ${column} GLOB 'dashboards/brief-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md')`
  );
}
