/** The packet's sections, in the order they are packed and rendered. */
export const PACKET_SECTIONS = ["canon", "graph", "timeline", "claims"] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];

/**
 * The fresh-agent sections of a session packet. They are not `include`
 * choices: purpose=session with no explicit `include` gathers them, and an
 * explicit `include` opts out.
 */
export const SESSION_SECTIONS = ["owner", "now", "commitments", "uncertain"] as const;
export type SessionSection = (typeof SESSION_SECTIONS)[number];

/** Purpose scopes what the compiler gathers (gap row 1 / RFC 0002 §10.6). */
export const PACKET_PURPOSES = [
  "session",
  "recall",
  "correction",
  "audit",
] as const;
export type PacketPurpose = (typeof PACKET_PURPOSES)[number];

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PurposeProfile {
  readonly include: readonly PacketSection[];
  readonly window_ms: number;
  /** Gather the owner, now, commitments and uncertain sections. */
  readonly session_state: boolean;
}

export function purposeProfile(purpose: PacketPurpose): PurposeProfile {
  switch (purpose) {
    case "session":
      return {
        include: ["canon", "graph", "timeline"],
        window_ms: 7 * DAY_MS,
        session_state: true,
      };
    case "recall":
      return {
        include: ["canon", "timeline", "claims"],
        window_ms: 30 * DAY_MS,
        session_state: false,
      };
    case "correction":
      return {
        include: ["claims", "canon"],
        window_ms: 90 * DAY_MS,
        session_state: false,
      };
    case "audit":
      return {
        include: ["claims", "canon", "timeline"],
        window_ms: 30 * DAY_MS,
        session_state: false,
      };
    default: {
      const _exhaustive: never = purpose;
      return _exhaustive;
    }
  }
}
