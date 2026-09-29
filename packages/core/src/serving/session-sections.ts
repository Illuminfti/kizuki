import type { AuditDenial } from "../agents";
import { toolAllowed } from "../agents";
import { compareRfc3339 } from "../agents/time";
import { getClaim } from "../claims/store";
import type { Claim } from "../contracts/proposal";
import { readSituations } from "../world/situations";
import type { SituationItem, SituationState } from "../world/situations";
import {
  claimLine,
  inline,
  loadSubjectConflicts,
  loadSubjectGaps,
} from "./candidates";
import type { Piece } from "./candidates";
import { claimReader } from "./claims";
import { SESSION_SECTIONS } from "./sections";
import type { SessionSection } from "./sections";
import type { ServeContext } from "./types";

/** Items per section and characters per captured text. Both keep a section a glance, not a dump. */
const SECTION_ITEMS = 5;
const SITUATIONS = 4;
const TEXT_CHARS = 160;
const CANDIDATES = 60;

/** Facts a fresh agent needs to know who it is working for. */
const OWNER_PREDICATES = [
  "identity.display_name",
  "identity.handle_on",
  "identity.same_as",
  "location.based_in",
  "employment.works_at",
  "employment.role",
] as const;
const COMMITMENT_PREDICATES = ["commitment.owes", "commitment.due"] as const;
const OWNER_TIERS = ["owner_correction", "owner_authored"] as const;

/** Why a section holds nothing. `budget` is set by the packer, never here. */
export type SessionEmptyReason =
  "none_recorded" | "not_granted" | "unavailable" | "budget";

export interface SessionSectionReport {
  /** Lines served in the packet body. */
  served: number;
  /** Present exactly when `served` is 0. */
  empty_reason?: SessionEmptyReason;
}
export type SessionReport = Record<SessionSection, SessionSectionReport>;

const EMPTY_TEXT: Record<
  SessionSection,
  Record<Exclude<SessionEmptyReason, "budget">, string>
> = {
  owner: {
    none_recorded: "no owner-authority identity facts are recorded",
    not_granted:
      "owner-authority identity facts are not readable under this grant",
    unavailable: "owner-authority identity facts could not be read",
  },
  now: {
    none_recorded: "no current situations or recent changes are recorded",
    not_granted:
      "situations need the world_view grant and no recent change is recorded",
    unavailable: "current situations and recent changes could not be read",
  },
  commitments: {
    none_recorded: "no open commitments are recorded",
    not_granted:
      "situation commitments need the world_view grant and no other commitment is recorded",
    unavailable: "open commitments could not be read",
  },
  uncertain: {
    none_recorded: "no open questions or contradictions are recorded",
    not_granted:
      "hedged situation statements need the world_view grant and no contradiction is recorded",
    unavailable: "open questions and contradictions could not be read",
  },
};

export function emptyReasonText(
  section: SessionSection,
  reason: SessionEmptyReason,
): string {
  return reason === "budget"
    ? "omitted to fit the token budget"
    : EMPTY_TEXT[section][reason];
}

export interface SessionPieces {
  pieces: Piece[];
  /** Empty-section reasons decided while gathering. */
  reasons: Partial<Record<SessionSection, SessionEmptyReason>>;
  withheld: AuditDenial[];
  degraded: string[];
}

function clamp(text: string): string {
  const points = Array.from(text.replace(/\s+/g, " ").trim());
  return points.length <= TEXT_CHARS
    ? points.join("")
    : `${points.slice(0, TEXT_CHARS - 1).join("")}…`;
}

function stamps(claim: Claim): string {
  return `c=${claim.confidence.toFixed(2)} s=${claim.sensitivity} taint=${claim.taint} auth=${claim.authority}`;
}

/** A world statement line: same stamps as a working-knowledge claim, with the situation named. */
function situationLine(state: SituationState, item: SituationItem): string {
  const hedge =
    item.polarity === "negative" || item.mode !== "asserted"
      ? ` polarity=${item.polarity} mode=${item.mode}`
      : "";
  return (
    `- [claim:${inline(item.claim.claim_id)}] ${stamps(item.claim)}${hedge}` +
    ` :: situation ${JSON.stringify(clamp(state.label ?? state.subject))} ${item.predicate.slice(10)} ${JSON.stringify(clamp(item.text))}\n`
  );
}

function piece(
  section: SessionSection,
  heading: string,
  block: string,
  ids: string[],
  reader: ReturnType<typeof claimReader>,
): Piece {
  return {
    section,
    heading,
    block,
    audit: ids.flatMap((id) => reader.auditClaim(id)),
  };
}

function claimPiece(
  section: SessionSection,
  heading: string,
  claim: Claim,
  reader: ReturnType<typeof claimReader>,
): Piece {
  return piece(
    section,
    heading,
    claimLine({
      ...claim,
      object: claim.object === null ? null : clamp(claim.object),
    }),
    [claim.claim_id],
    reader,
  );
}

/** Live claims matching `where`, newest first, that `keep` and the reader clear. */
function readable(
  ctx: ServeContext,
  reader: ReturnType<typeof claimReader>,
  where: string,
  bindings: (string | number)[],
  keep: (claim: Claim) => boolean,
): Claim[] {
  const found: Claim[] = [];
  for (const row of ctx.db
    .query<{ claim_id: string }, (string | number)[]>(
      `SELECT claim_id FROM claims WHERE status='live' AND ${where} ORDER BY asserted_at DESC, claim_id LIMIT ${CANDIDATES}`,
    )
    .iterate(...bindings)) {
    const claim = getClaim(ctx.db, row.claim_id);
    if (claim === null || !keep(claim) || !reader.canRead(claim)) continue;
    found.push(claim);
    if (found.length === SECTION_ITEMS) break;
  }
  return found;
}

const marks = (values: readonly string[]) => values.map(() => "?").join(",");

/**
 * The owner, now, commitments and uncertain sections of a session packet.
 * Everything is read from claims and the world model under the caller's own
 * grant; nothing is inferred, and a section with no data says why it is empty.
 */
export function collectSessionPieces(
  ctx: ServeContext,
  request: { at: string; since: string; subjects?: readonly string[] },
): SessionPieces {
  const grant = ctx.principal.grant;
  const reader = claimReader(ctx.db, grant, {
    owner: ctx.principal.kind === "owner",
    purpose: ctx.sourcePurpose ?? "session",
  });
  const inSubjects = (claim: Claim): boolean =>
    request.subjects === undefined ||
    request.subjects.length === 0 ||
    (claim.subject === null ? claim.subjects : [claim.subject]).some((id) =>
      request.subjects!.includes(id),
    );
  const worldGranted =
    ctx.principal.kind === "owner" || toolAllowed(grant, "world_view");
  const pieces: Record<SessionSection, Piece[]> = {
    owner: [],
    now: [],
    commitments: [],
    uncertain: [],
  };
  const reasons: SessionPieces["reasons"] = {};
  const degraded: string[] = [];
  const shown = new Set<string>();

  const run = (section: SessionSection, gather: () => Piece[]): void => {
    try {
      pieces[section] = gather();
    } catch {
      // The cause stays inside core; the section reports itself unavailable.
      pieces[section] = [];
      reasons[section] = "unavailable";
      degraded.push(`session-${section}-unavailable`);
    }
  };
  const situations = (): SituationState[] => {
    if (!worldGranted) return [];
    return readSituations(ctx, {
      limit: SITUATIONS,
      at: request.at,
      ...(request.subjects === undefined || request.subjects.length === 0
        ? {}
        : { subjects: request.subjects }),
      canRead: reader.canRead,
    });
  };
  let situationCache: SituationState[] | undefined;
  const world = (): SituationState[] => (situationCache ??= situations());

  run("owner", () => {
    const facts = readable(
      ctx,
      reader,
      `authority IN (${marks(OWNER_TIERS)}) AND polarity='positive' AND subject IS NOT NULL AND predicate IN (${marks(OWNER_PREDICATES)})`,
      [...OWNER_TIERS, ...OWNER_PREDICATES],
      inSubjects,
    );
    for (const claim of facts) shown.add(claim.claim_id);
    return facts.map((claim) =>
      claimPiece("owner", "## owner (owner-authority facts)", claim, reader),
    );
  });

  run("now", () => {
    const lines: Piece[] = [];
    for (const state of world()) {
      const items = [...state.objective, ...state.blocker, ...state.change];
      for (const item of items) {
        lines.push(
          piece(
            "now",
            "## now (situations)",
            situationLine(state, item),
            [item.claim.claim_id],
            reader,
          ),
        );
      }
    }
    const changes = readable(
      ctx,
      reader,
      `claim_key IS NOT NULL AND is_world_typed=0 AND asserted_at >= ? AND predicate NOT IN (${marks(COMMITMENT_PREDICATES)})`,
      [request.since, ...COMMITMENT_PREDICATES],
      (claim) =>
        inSubjects(claim) &&
        !shown.has(claim.claim_id) &&
        compareRfc3339(claim.asserted_at, "asserted_at", request.at, "at") <= 0,
    );
    for (const claim of changes) {
      shown.add(claim.claim_id);
      lines.push(claimPiece("now", "## now (recent changes)", claim, reader));
    }
    if (lines.length === 0 && !worldGranted) reasons.now = "not_granted";
    return lines.slice(0, SECTION_ITEMS + SITUATIONS);
  });

  run("commitments", () => {
    const lines: Piece[] = [];
    for (const state of world()) {
      for (const item of state.commitments) {
        lines.push(
          piece(
            "commitments",
            "## commitments (open)",
            situationLine(state, item),
            [item.claim.claim_id],
            reader,
          ),
        );
      }
    }
    const claims = readable(
      ctx,
      reader,
      `polarity='positive' AND predicate IN (${marks(COMMITMENT_PREDICATES)})`,
      [...COMMITMENT_PREDICATES],
      inSubjects,
    );
    for (const claim of claims)
      lines.push(
        claimPiece("commitments", "## commitments (open)", claim, reader),
      );
    if (lines.length === 0 && !worldGranted)
      reasons.commitments = "not_granted";
    return lines.slice(0, SECTION_ITEMS);
  });

  run("uncertain", () => {
    const lines: Piece[] = [];
    for (const state of world()) {
      for (const item of state.uncertain) {
        lines.push(
          piece(
            "uncertain",
            "## uncertain (contradictions and open questions)",
            situationLine(state, item),
            [item.claim.claim_id],
            reader,
          ),
        );
      }
    }
    const wanted =
      request.subjects === undefined || request.subjects.length === 0
        ? undefined
        : [...request.subjects];
    for (const conflict of loadSubjectConflicts(
      ctx.db,
      wanted,
      reader.canRead,
    )) {
      const first = getClaim(ctx.db, conflict.claims[0]?.claim_id ?? "");
      const values = conflict.claims.map(
        (member) =>
          `${member.polarity === "negative" ? "not " : ""}${JSON.stringify(clamp(member.object ?? ""))} (auth=${member.authority} c=${member.confidence.toFixed(2)})`,
      );
      lines.push(
        piece(
          "uncertain",
          "## uncertain (contradictions and open questions)",
          `- conflict key=${inline(conflict.claim_key.slice(0, 12))} live=${conflict.claims.length} :: ${inline(first?.subject ?? "-")} ${inline(first?.predicate ?? "-")} ${values.join(" vs ")}\n`,
          conflict.claims.map((member) => member.claim_id),
          reader,
        ),
      );
    }
    for (const gap of loadSubjectGaps(ctx.db, wanted, reader.canRead)) {
      lines.push(
        piece(
          "uncertain",
          "## uncertain (contradictions and open questions)",
          `- gap key=${inline(gap.claim_key.slice(0, 12))} ${inline(gap.predicate ?? "-")} unknown between ${inline(gap.after)} and ${inline(gap.before)}\n`,
          [],
          reader,
        ),
      );
    }
    if (lines.length === 0 && !worldGranted) reasons.uncertain = "not_granted";
    return lines.slice(0, SECTION_ITEMS);
  });

  // Empty sections share one trailing heading so a silent packet still explains itself.
  const out: Piece[] = [];
  const explained: Piece[] = [];
  for (const section of SESSION_SECTIONS) {
    if (pieces[section].length > 0) {
      out.push(...pieces[section]);
      continue;
    }
    const reason = reasons[section] ?? (reasons[section] = "none_recorded");
    explained.push({
      section,
      heading: "## not recorded",
      block: `- ${section}: ${emptyReasonText(section, reason)} [${reason}]\n`,
      placeholder: true,
    });
  }
  out.push(...explained);
  return {
    pieces: out,
    reasons,
    withheld: [...reader.denied.values()],
    degraded,
  };
}
