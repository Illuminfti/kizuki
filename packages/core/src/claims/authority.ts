import type { ClaimDraft } from "../contracts/producer";
import type {
  AuthorityTier,
  CanonicalProducer,
  ClaimTaint,
  Producer,
} from "../contracts/proposal";
import { AUTHORITY_TIERS, canonicalizeProducer } from "../contracts/proposal";
import { ClaimError } from "./errors";

export const SINGLE_SOURCE_CAP = 0.5;

export interface EventFacts {
  readonly event_id: string;
  readonly connector_id: string;
  readonly taint: "untrusted" | "owner";
  readonly text: string;
  readonly origin?: "external" | "self";
}

export interface AuthorityDraft {
  readonly producer: Producer;
  readonly taint: ClaimTaint;
  readonly body: string;
  readonly provenance: readonly string[];
  readonly confidence: number;
  readonly intent?: "propose" | "correct";
  readonly claim_key?: string | null;
}

export interface AuthorityAssignment {
  readonly authority: AuthorityTier;
  readonly confidence: number;
  readonly relayed_by: string | null;
}

function isVerbatimQuote(draft: AuthorityDraft, events: EventFacts[]): boolean {
  if (draft.taint !== "quoted") return false;
  const body = draft.body.trim();
  if (!body.startsWith(">")) return false;
  const quoted = body
    .split(/\r?\n/)
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line.startsWith(">") ? line.slice(1) : line))
    .join("\n")
    .trim();
  if (quoted.length === 0) return false;
  return events.some((event) => event.text.includes(quoted) || quoted.includes(event.text.trim()));
}

function baseAuthority(
  producer: CanonicalProducer,
  draft: AuthorityDraft,
  events: EventFacts[],
): AuthorityTier {
  if (draft.intent === "correct") return "owner_correction";
  if (producer === "owner") return "owner_authored";
  if (producer === "model") {
    return isVerbatimQuote(draft, events) ? "connector_evidence" : "model_inference";
  }
  if (events.length > 0 && events.every((event) => event.taint === "owner")) {
    return "owner_authored";
  }
  return "connector_evidence";
}

function clampAtMost(
  current: AuthorityTier,
  ceiling: AuthorityTier,
): AuthorityTier {
  return AUTHORITY_TIERS[current] <= AUTHORITY_TIERS[ceiling]
    ? current
    : ceiling;
}

export function authorityFor(
  claim: AuthorityDraft | ClaimDraft,
  ev: EventFacts[],
  extras: {
    producer: Producer;
    taint?: ClaimTaint;
    body?: string;
    provenance?: readonly string[];
    intent?: "propose" | "correct";
    hasCorroboration?: boolean;
    /** RFC 0002 §6.4: the tier a relay may not exceed. */
    relayCeiling?: AuthorityTier;
  },
): AuthorityAssignment {
  const producer = canonicalizeProducer(extras.producer);
  const intent =
    extras.intent ??
    ("intent" in claim ? (claim as AuthorityDraft).intent : "propose");
  const draft: AuthorityDraft = {
    producer,
    taint: extras.taint ?? ("taint" in claim ? (claim as AuthorityDraft).taint : "clean"),
    body: extras.body ?? ("body" in claim ? claim.body : ""),
    provenance:
      extras.provenance ??
      ("provenance" in claim
        ? (claim as AuthorityDraft).provenance
        : "event_ids" in claim
          ? claim.event_ids
          : []),
    confidence: claim.confidence,
    ...(intent === undefined ? {} : { intent }),
    claim_key:
      "claim_key" in claim
        ? ((claim as AuthorityDraft).claim_key ?? null)
        : null,
  };

  if (draft.provenance.length === 0) {
    throw new ClaimError("schema_invalid", "authority requires provenance");
  }

  let authority = baseAuthority(producer, draft, ev);
  let confidence = draft.confidence;
  let relayed_by: string | null = null;

  if (producer === "model" && !isVerbatimQuote(draft, ev)) {
    authority = clampAtMost(authority, "model_inference");
  }

  const uniqueConnectors = new Set(ev.map((event) => event.connector_id));
  const singleUntrusted =
    ev.length === 1 &&
    ev[0]?.taint === "untrusted" &&
    extras.hasCorroboration !== true &&
    uniqueConnectors.size <= 1 &&
    draft.intent !== "correct" &&
    authority !== "owner_correction" &&
    authority !== "owner_authored";
  if (singleUntrusted) {
    authority = "model_inference";
    confidence = Math.min(confidence, SINGLE_SOURCE_CAP);
  }

  if (typeof extras.producer === "string" && extras.producer.startsWith("agent:")) {
    relayed_by = extras.producer;
    if (draft.intent === "correct") {
      authority = clampAtMost("owner_correction", extras.relayCeiling ?? "owner_correction");
    } else {
      authority = clampAtMost(authority, "connector_evidence");
    }
  }

  return { authority, confidence, relayed_by };
}
