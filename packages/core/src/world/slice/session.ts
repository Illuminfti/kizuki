import { scopePacketPieces } from "../../serving/v2/packet-pieces";
import { toolAllowed, type AuditItem } from "../../agents";
import { MAX_AUDIT_ITEMS } from "../../agents/types";
import { getClaim } from "../../claims/store";
import type { SliceItem } from "../../contracts/world-slice";
import type { Piece } from "../../serving/candidates";
import { claimReader } from "../../serving/claims";
import { packetTokens } from "../../serving/packet-tokenizer";
import { redactorOf } from "../../serving/redact";
import { SESSION_SECTIONS, type SessionSection } from "../../serving/sections";
import { collectSessionPieces, emptyReasonText, SESSION_STATE_NOTE, type SessionPieces } from "../../serving/session-sections";
import type { ServeContext } from "../../serving/types";
import { sourceCoverage } from "../coverage";
import { worldDependencies, type WorldDependencies } from "../dependencies";
import { sessionPerson } from "../person-session";
import { readCurrentSituations } from "../situations";
import { compileUnits } from "./compile";
import { cardSliceItems, sliceAssembler } from "./providers";

interface Unit { readonly piece: Piece; readonly required: boolean }
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
  at: string; since: string; subjects?: readonly string[]; header: string; budgetTokens: number;
}): SessionPieces & { truncated: boolean } {
  // Retain the model-free owner identity/legacy claim floor. Typed reads are disabled here.
  const legacy = collectSessionPieces(ctx, { ...request, typed: false });
  const units: Unit[] = [], world: WorldDependencies[] = [...legacy.world];
  const reasons = { ...legacy.reasons }, degraded = [...legacy.degraded];
  const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "session" });
  const redactor = redactorOf(ctx);
  const granted = ctx.principal.kind === "owner" || toolAllowed(ctx.principal.grant, "world_view");
  const seenPeople = new Set<string>();
  const qualified = (item: SliceItem, section: SessionSection, deps: WorldDependencies, heading: string, ids: readonly string[], extra = ""): Piece => ({
    section, heading, scopedBlock: true,
    block: redactor.format(JSON.stringify(item), value => `- taint=quoted mode=${item.relation.perspective.mode}${extra} :: slice ${value}\n`),
    audit: ids.flatMap(id => reader.auditClaim(id)), claims: reader.publication(ids), world: deps,
  });
  for (const piece of legacy.pieces) {
    if (piece.placeholder) continue;
    if (granted && piece.section === "owner") {
      const identity = (piece.claims ?? []).map(row => getClaim(ctx.db, row.id)).find(row => row !== null);
      const person = identity === undefined || identity === null ? null : sessionPerson(ctx, identity, request.at);
      const assembler = sliceAssembler("person");
      if (person !== null && assembler?.sliceConstraint !== undefined) {
        const ids = [identity!.claim_id, ...person.deps.claims];
        if (ids.every(id => { const row = getClaim(ctx.db, id); return row !== null && reader.canRead(row); })) {
          world.push(person.deps);
          if (seenPeople.has(person.card.person.ref.token)) continue;
          seenPeople.add(person.card.person.ref.token);
          units.push({ required: true, piece: {
            scopedBlock: true, section: "owner", heading: "## owner (Person card; quoted data)",
            block: redactor.format(JSON.stringify({ person: person.card.person.ref, labels: person.card.person.labels }), value => `- taint=quoted :: Person labels ${value}; no agreement inferred.\n`),
            audit: ids.flatMap(id => reader.auditClaim(id)), claims: reader.publication(ids), world: person.deps,
          } });
          for (const gap of person.card.coverage.gaps) degraded.push(gap);
          const items = cardSliceItems("person", person.card.person.ref, person.card, assembler);
          for (const item of items.constraints) units.push({ piece: qualified(item, "owner", person.deps, "## owner (Person card; quoted data)", ids), required: true });
          for (const item of items.detail) units.push({ piece: qualified(item, "owner", person.deps, "## owner (Person card; quoted data)", ids), required: false });
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
      const states = readCurrentSituations(ctx, { limit: 5, canRead: reader.canRead,
        ...(request.subjects === undefined ? {} : { subjects: request.subjects }) });
      if (states.length > 4) { degraded.push("traversal_limit"); world.push(states[4]!.world); }
      for (const state of states.slice(0, 4)) {
        // Includes completed commitments omitted from rendering: a revocation can reopen them.
        world.push(state.world); degraded.push(...state.card.coverage.gaps);
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
            units.push({ required, piece: qualified(item, section, state.world,
              `## ${section} (Situation card; quoted data)`, [...state.world.claims], extra) });
          }
        }
      }
    }
  }
  const auditFits = (pieces: readonly Piece[]) => new Set(pieces.flatMap(piece => (piece.audit ?? []).map((item: AuditItem) => item.id))).size <= MAX_AUDIT_ITEMS;
  const scopedUnits = units.flatMap(unit => scopePacketPieces(ctx, [unit.piece]).map(piece => ({ ...unit, piece })));
  const compiled = compileUnits(scopedUnits.filter(unit => unit.required), scopedUnits.filter(unit => !unit.required), (constraints, detail) => {
    const pieces = ordered([...constraints, ...detail]);
    return auditFits(pieces) && packetTokens(redactor.join([request.header, rendered(pieces)])) <= request.budgetTokens;
  });
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
