import { CONTEXT_PACKET_MARKERS } from "../../canon/origin";
import { isWorldWireToken } from "../../world/ops/parse";
import type { ViewResult, ViewToken } from "../../world/ops/types";
import type { ContextPacketArgs, ContextPacketData } from "../packet";
import type { PacketPurpose } from "../sections";
import type { SessionReport } from "../session-sections";
import type { TaskAttachment } from "../task-sections";
import { ServeError } from "../types";

export const PACKET_V2_SCHEMA = "kizuki.context-packet/v2" as const;
export const PACKET_V2_MARKER = CONTEXT_PACKET_MARKERS.v2;

/** The v1 keys that only make sense with a global epoch; selecting v2 alone chooses the new packet. */
const LEGACY_KEYS = [
  "capabilities",
  "retain_prefix",
  "prior_hash",
  "epoch",
] as const;

export type ContextPacketArgsV2 = Omit<
  ContextPacketArgs,
  (typeof LEGACY_KEYS)[number]
> & {
  /** The view of the packet the caller still holds; an unchanged answer carries no body. */
  priorView?: ViewToken;
};

/** Everything a reader needs from a packet, with no global counter and no digest to compare. */
export interface PacketContentV2 {
  packetMd: string;
  /** Exact encoded count of `packetMd` under the declared tokenizer. */
  tokens: number;
  budgetTokens: number;
  tokenizer: string;
  purpose: PacketPurpose;
  sections: ContextPacketData["sections"];
  /** True when packing stopped because a later in-scope chunk would exceed the budget. */
  truncated: boolean;
  retrievalDegraded: string[];
  session?: SessionReport;
  lifecycle?: ContextPacketData["lifecycle"];
  task?: TaskAttachment;
}

export interface ContextPacketDataV2 {
  schema: typeof PACKET_V2_SCHEMA;
  result: Extract<
    ViewResult<PacketContentV2>,
    { status: "current"; view: ViewToken } | { status: "unchanged" | "incomplete" }
  >;
}

/** Rejects a v1 baseline key before anything is read; it would be a second version switch. */
export function rejectLegacyKeys(args: object): void {
  for (const key of LEGACY_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new ServeError(
        "invalid_arguments",
        `invalid arguments: ${key}: not accepted under kizuki.envelope/v2`,
      );
    }
  }
}

/** The token of a caller's baseline, or undefined when it names none. */
export function priorViewOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const view = value as Partial<ViewToken> | null;
  if (
    typeof view !== "object" ||
    view === null ||
    Object.keys(view).length !== 2 ||
    view.kind !== "view" ||
    typeof view.token !== "string" ||
    !isWorldWireToken(view.token)
  ) {
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: priorView: must be a view token",
    );
  }
  return view.token;
}

/**
 * A content baseline that grants nothing: unchanged is decided by rebuilding
 * the complete authorized packet and comparing it, including metadata and
 * chunks. A token is checked only against what its holder may read.
 */
export function packetView(content: PacketContentV2, canon: unknown, quoted: unknown): ViewToken {
  const token = new Bun.CryptoHasher("sha256")
    .update(`${PACKET_V2_SCHEMA}\0`)
    .update(JSON.stringify({ content, canon, quoted }))
    .digest("base64url");
  return { kind: "view", token };
}
