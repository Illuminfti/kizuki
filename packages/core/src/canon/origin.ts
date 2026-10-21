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
 * The first line of every context packet Kizuki serves, one per packet
 * contract. Captured text that carries either marker is machine output fed
 * back in, so ingress never treats it as a source.
 */
export const CONTEXT_PACKET_MARKERS = {
  v1: "KIZUKI CONTEXT v1",
  v2: "KIZUKI CONTEXT v2",
} as const;

export function hasContextPacketMarker(text: string): boolean {
  return (
    text.includes(CONTEXT_PACKET_MARKERS.v1) ||
    text.includes(CONTEXT_PACKET_MARKERS.v2)
  );
}
