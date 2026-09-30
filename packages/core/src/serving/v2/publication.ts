import type { Tool } from "../../agents";
import { sensitivity, SENSITIVITY_ORDER } from "../../agents";
import { getClaim } from "../../claims/store";
import { eligible, loadCanon, pageDecision } from "../canon";
import { claimReader, claimPublicationFingerprint } from "../claims";
import type { Served } from "../gate";
import { currentQuotedSource, eventDecision } from "../ledger";
import { ServeError } from "../types";
import type { ServeContext } from "../types";

/**
 * Revalidate only evidence actually published. A vault-wide fence cannot
 * decide whether a scoped answer is current: unrelated writes are invisible.
 * The gate calls this and seals the answer in one immediate transaction.
 */
export function validatePublication(ctx: ServeContext, tool: Tool, served: Served<unknown>): void {
  if (tool === "propose" || tool === "correct") return;
  if (served.authorization?.purpose !== undefined) ctx = { ...ctx, sourcePurpose: served.authorization.purpose };
  function refuse(): never { throw new ServeError("error", "authorized evidence changed during request; retry"); }
  const eventIds = new Set(served.quoted.map((chunk) => chunk.event_id));
  const eventLabels = new Map(served.quoted.map((chunk) => [chunk.event_id, chunk.sensitivity]));
  // Attached identity evidence can raise a chunk's label above its source.
  // Reauthorization must never publish under a label below the current floor.
  const underLabeled = (label: import("../../agents").Sensitivity | undefined, current: import("../../agents").Sensitivity): boolean =>
    label !== undefined && SENSITIVITY_ORDER[label] < SENSITIVITY_ORDER[current];
  const pageIds = new Set(served.canon.map((chunk) => chunk.page_id));
  const pageLabels = new Map(served.canon.map((chunk) => [chunk.page_id, chunk.sensitivity]));
  for (const event of served.authorization?.events ?? []) {
    eventIds.add(event.id);
    if (event.sensitivity !== undefined) eventLabels.set(event.id, event.sensitivity);
  }
  const pageHashes = new Map((served.authorization?.pages ?? []).map((page) => [page.id, page.hash]));
  for (const page of served.authorization?.pages ?? []) if (page.sensitivity !== undefined) pageLabels.set(page.id, page.sensitivity);
  for (const id of pageHashes.keys()) pageIds.add(id);
  for (const id of eventIds) {
    const source = currentQuotedSource(ctx.db, id);
    if (source === null) refuse();
    const decision = eventDecision(ctx.principal.grant, source, ctx);
    if (!decision.allow || underLabeled(eventLabels.get(id), decision.sensitivity)) refuse();
  }
  if (pageIds.size > 0) {
    const index = loadCanon(ctx);
    for (const id of pageIds) {
      const page = index.byId.get(id);
      if (page === undefined || !eligible(page) || (pageHashes.has(id) && pageHashes.get(id) !== page.contentHash)) refuse();
      const decision = pageDecision(index, ctx.principal.grant, page);
      if (!decision.allow || underLabeled(pageLabels.get(id), decision.sensitivity)) refuse();
    }
  }
  const claims = served.audit_served ?? [];
  const stamps = new Map((served.authorization?.claims ?? []).map((item) => [item.id, item]));
  for (const item of claims) if (!stamps.has(item.id)) {
    const label = sensitivity(item.sensitivity);
    if (label === null) refuse();
    stamps.set(item.id, { id: item.id, fingerprint: "", sensitivity: label });
  }
  if (stamps.size > 0) {
    const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" });
    for (const [id, stamp] of stamps) {
      const claim = getClaim(ctx.db, id);
      if (claim === null || (stamp.fingerprint === "" ? claim.status !== "live" : claimPublicationFingerprint(claim) !== stamp.fingerprint) || !reader.canRead(claim) || claim.sensitivity !== stamp.sensitivity) refuse();
    }
  }
}
