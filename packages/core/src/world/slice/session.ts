import { scopePacketPieces } from "../../serving/v2/packet-pieces";
import { toolAllowed, type AuditItem } from "../../agents";
import { MAX_AUDIT_ITEMS } from "../../agents/types";
import { getClaim } from "../../claims/store";
import type { SliceItem } from "../../contracts/world-slice";
import type { Piece } from "../../serving/candidates";
import { claimReader, type ClaimPublication } from "../../serving/claims";
import { packetTokens } from "../../serving/packet-tokenizer";
import { redactorOf } from "../../serving/redact";
import { SESSION_SECTIONS, type SessionSection } from "../../serving/sections";
import { collectSessionPieces, emptyReasonText, SESSION_STATE_NOTE, type SessionPieces } from "../../serving/session-sections";
import type { ServeContext } from "../../serving/types";
import { sourceCoverage } from "../coverage";
import { worldDependencies, type WorldDependencies } from "../dependencies";
import { sessionPerson } from "../person-session";
import { readCurrentSituations } from "../situations";
import { compilePacketUnits, packetSliceBudget } from "./compile";
import { cardSliceItems, sliceAssembler } from "./providers";
import { queryTerms, sliceItemRelevance } from "./relevance";

interface Unit { readonly piece: Piece; readonly required: boolean; readonly relevance?: number }
const sectionOrder = (piece: Piece) => SESSION_SECTIONS.indexOf(piece.section as SessionSection);
function ordered(units: readonly Unit[]): Piece[] {
  return units.map(unit => unit.piece).sort((a, b) => sectionOrder(a) - sectionOrder(b));
}
/** Exactly the section rendering the packet uses; the compiler measures complete lines. */
function rendered(pieces: readonly Piece[]): string {
  let heading = "", noted = false, body = "";
  for (const piece of pieces) {
    const note = piece.placeholder !== true && !noted ? SESSION_STATE_NOTE : "";
    body += `${note}${heading === piece.heading ? "" : `${piece.heading}\n`}${piece.block}`;
    heading = piece.heading;
    noted ||= piece.placeholder !== true;
  }
  return body;
}

/** Legacy owner selectors feed the same card providers and mandatory-first compiler as world slices.
 * No second typed claim collector, no model call and no canon write. */
export function compileSessionSlice(ctx: ServeContext, request: {
  at: string; since: string; subjects?: readonly string[]; query?: string; header: string; budgetTokens: number; reservedTokens?: number;
}): SessionPieces & { truncated: boolean } {
  // Retain the model-free owner identity/legacy claim floor. Typed reads are disabled here.
  const legacy = collectSessionPieces(ctx, { ...request, typed: false });
  const units: Unit[] = [], world: WorldDependencies[] = [...legacy.world];
  const reasons = { ...legacy.reasons }, degraded = [...legacy.degraded];
  const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "session" });
  const redactor = redactorOf(ctx);
  const granted = ctx.principal.kind === "owner" || toolAllowed(ctx.principal.grant, "world_view");
  const seenPeople = new Set<string>();
  const seenClaims = new Map<string, number>();
  const terms = queryTerms(request.query);
  const qualified = (
    item: SliceItem,
    section: SessionSection,
    deps: WorldDependencies,
    heading: string,
    audit: readonly AuditItem[],
    claims: readonly ClaimPublication[],
    extra = "",
  ): Piece => ({
    section, heading, scopedBlock: true,
    block: redactor.format(JSON.stringify(item), value => `- taint=quoted mode=${item.relation.perspective.mode}${extra} :: slice ${value}\n`),
    audit: [...audit], claims: [...claims], world: deps,
  });
  const pushSliceUnit = (claimToken: string, unit: Unit) => {
    const existing = seenClaims.get(claimToken);
    if (existing !== undefined) {
      const prior = units[existing]!;
      units[existing] = {
        ...prior,
        required: prior.required || unit.required,
        relevance: Math.max(prior.relevance ?? 0, unit.relevance ?? 0),
      };
      return;
    }
    seenClaims.set(claimToken, units.length);
    units.push(unit);
  };
  for (const piece of legacy.pieces) {
    if (piece.placeholder) continue;
    if (granted && piece.section === "owner") {
      const identity = (piece.claims ?? []).map(row => getClaim(ctx.db, row.id)).find(row => row !== null);
      const person = identity === undefined || identity === null ? null : sessionPerson(ctx, identity, request.at);
      const assembler = sliceAssembler("person");
      if (person !== null && assembler?.sliceConstraint !== undefined) {
        const extraIds = [...person.deps.claims].filter(id => id !== identity!.claim_id);
        if (reader.canRead(identity!) && extraIds.every(id => { const row = getClaim(ctx.db, id); return row !== null && reader.canRead(row); })) {
          world.push(person.deps);
          if (seenPeople.has(person.card.person.ref.token)) continue;
          seenPeople.add(person.card.person.ref.token);
          const ids = [identity!.claim_id, ...extraIds];
          const audit = ids.flatMap(id => reader.auditClaim(id)), claims = reader.publication(ids);
          const labels = person.card.person.labels.map(label => label.text);
          units.push({ required: true, piece: {
            scopedBlock: true, section: "owner", heading: "## owner (Person card; quoted data)",
            block: redactor.format(JSON.stringify({ person: person.card.person.ref, labels: person.card.person.labels }), value => `- taint=quoted :: Person labels ${value}; no agreement inferred.\n`),
            audit, claims, world: person.deps,
          } });
          for (const gap of person.card.coverage.gaps) degraded.push(gap);
          const items = cardSliceItems("person", person.card.person.ref, person.card, assembler);
          for (const item of items.constraints) pushSliceUnit(item.relation.claim.token, { piece: qualified(item, "owner", person.deps, "## owner (Person card; quoted data)", audit, claims), required: true, relevance: sliceItemRelevance(item, terms, redactor, labels) });
          for (const item of items.detail) pushSliceUnit(item.relation.claim.token, { piece: qualified(item, "owner", person.deps, "## owner (Person card; quoted data)", audit, claims), required: false, relevance: sliceItemRelevance(item, terms, redactor, labels) });
          continue;
        }
      }
    }
    units.push({ piece, required: piece.section === "owner" || piece.section === "commitments" || piece.section === "uncertain" });
  }
  if (granted) {
    const coverage = worldDependencies();
    degraded.push(...sourceCoverage(ctx, coverage)); world.push(coverage);
    const assembler = sliceAssembler("situation");
    if (assembler?.sliceConstraint === undefined) degraded.push("coverage");
    else {
      const states = readCurrentSituations(ctx, { limit: 5, canRead: reader.canRead, projection: "relations",
        ...(request.subjects === undefined ? {} : { subjects: request.subjects }) });
      if (states.length > 4) { degraded.push("traversal_limit"); world.push(states[4]!.world); }
      for (const state of states.slice(0, 4)) {
        // Includes completed commitments omitted from rendering: a revocation can reopen them.
        world.push(state.world); degraded.push(...state.card.coverage.gaps);
        const ids = [...state.world.claims];
        const audit = ids.flatMap(id => reader.auditClaim(id)), claims = reader.publication(ids);
        const labels = state.card.situation.labels.map(label => label.text);
        const items = cardSliceItems("situation", state.card.situation.ref, state.card, assembler);
        const uncertain = new Set(state.card.uncertainty.map(item => item.claim.token));
        const commitmentState = new Map(state.card.commitments.map(item => [item.commitment.token, item]));
        for (const [required, candidates] of [[true, items.constraints], [false, items.detail]] as const) {
          for (const item of candidates) {
            const commitment = commitmentState.get(item.relation.subject.token);
            if (commitment?.status === "done" || commitment?.status === "dropped") continue;
            const section = uncertain.has(item.relation.claim.token) || item.relation.polarity === "negative" || item.relation.perspective.mode !== "asserted" ? "uncertain" :
              commitment !== undefined || item.relation.predicate === "situation.commitment" ? "commitments" : "now";
            const extra = commitment === undefined ? "" : ` status=${commitment.status} overdue=${commitment.overdue}`;
            // Card-level ambiguity can put an asserted relation in uncertainty
            // even when its own qualifiers do not declare a conflict.
            pushSliceUnit(item.relation.claim.token, {
              required: required || uncertain.has(item.relation.claim.token),
              relevance: sliceItemRelevance(item, terms, redactor, labels),
              piece: qualified(item, section, state.world, `## ${section} (Situation card; quoted data)`, audit, claims, extra),
            });
          }
        }
      }
    }
  }
  const auditFits = (pieces: readonly Piece[]) => new Set(pieces.flatMap(piece => (piece.audit ?? []).map((item: AuditItem) => item.id))).size <= MAX_AUDIT_ITEMS;
  const byPiece = new Map(units.map(unit => [unit.piece, unit] as const));
  const scopedUnits = scopePacketPieces(ctx, units.map(unit => unit.piece)).map(piece =>
    byPiece.get(piece) ?? { piece, required: piece.section === "owner" || piece.section === "commitments" || piece.section === "uncertain" },
  );
  // Rank only authorized, complete units. Query relevance affects which whole
  // required prefix survives overflow, never whether a relation is required.
  const byRelevance = (a: Unit, b: Unit) => (b.relevance ?? 0) - (a.relevance ?? 0);
  const required = scopedUnits.filter(unit => unit.required).sort(byRelevance);
  const detail = scopedUnits.filter(unit => !unit.required).sort(byRelevance);
  const shareLimit = packetSliceBudget(packetTokens(request.header), request.budgetTokens, request.reservedTokens);
  const within = (constraints: readonly Unit[], details: readonly Unit[], limit: number) => {
    const pieces = ordered([...constraints, ...details]);
    return auditFits(pieces) && packetTokens(redactor.join([request.header, rendered(pieces)])) <= limit;
  };
  const compiled = compilePacketUnits(required, detail, within, shareLimit, request.budgetTokens);
  const pieces = ordered([...compiled.constraints, ...compiled.detail]);
  if (compiled.overflow) degraded.push("required_context_overflow");
  for (const section of SESSION_SECTIONS) {
    if (pieces.some(piece => piece.section === section)) { delete reasons[section]; continue; }
    const had = units.some(unit => unit.piece.section === section);
    const reason = had ? "budget" : reasons[section] ?? "none_recorded";
    reasons[section] = reason;
    const placeholder: Piece = { section, heading: "## not recorded", placeholder: true,
      block: `- ${section}: ${emptyReasonText(section, reason)} [${reason}]\n` };
    if (packetTokens(redactor.join([request.header, rendered([...pieces, placeholder])])) <= request.budgetTokens) pieces.push(placeholder);
  }
  return { pieces, reasons, world, degraded: [...new Set(degraded)], withheld: [...legacy.withheld, ...reader.denied.values()], truncated: compiled.truncated };
}
