import type { Tool } from "../../agents";
import type { RawSubjectRef } from "../../contracts/claim-v2";
import type { GraphAnchorV2 } from "../../contracts/scoped-tools";
import type { ScopedRef, PageRef, RawSubjectWireRef, SourceRef } from "../../contracts/scoped-refs";
import type { EvidenceSelection } from "../../query/selection";
import { missingReference, referenceScope, requireScopedRef } from "../../world/ref-kinds/common";
import { resolveEventVersionRef } from "../../world/ref-kinds/evidence";
import { resolvePageRef } from "../../world/ref-kinds/page";
import { resolveRawSubjectRef } from "../../world/ref-kinds/raw-subject";
import { resolveSourceRef } from "../../world/ref-kinds/source";
import { ENVELOPE_V2_SCHEMA, ServeError, type ResponseContract, type ServeContext } from "../types";
import type { SearchArgs } from "../search";
import type { TimelineArgs } from "../timeline";
import type { GraphArgs } from "../graph";
import type { ContextPacketArgs } from "../packet";
import type { ViewToken } from "../../world/ops/types";

export type SearchArgsV2 = Omit<SearchArgs, "subjects"> & { subjects?: RawSubjectWireRef[] };
export type GetPageArgsV2 = { page: PageRef };
export type TimelineArgsV2 = Omit<TimelineArgs, "subject" | "connector_id" | "event_id"> & { subject?: RawSubjectWireRef; source?: SourceRef; eventVersion?: ScopedRef<"event_version"> };
export type GraphArgsV2 = Omit<GraphArgs, "id"> & { anchor: GraphAnchorV2 };
export type PacketArgsV2 = Omit<ContextPacketArgs, "subjects" | "capabilities" | "retain_prefix" | "prior_hash" | "epoch" | "task_event_id"> & { subjects?: RawSubjectWireRef[]; priorView?: ViewToken; taskEventVersion?: ScopedRef<"event_version"> };
const KEYS: Partial<Record<Tool, readonly string[]>> = {
  search: ["query", "scope", "limit", "types", "subjects", "since", "until", "full_text"],
  get_page: ["page"], query_entities: ["type", "name", "limit"],
  timeline: ["day", "since", "until", "subject", "source", "kind", "limit", "eventVersion", "offset", "span", "integrity"],
  graph_neighbors: ["anchor", "depth", "kinds"],
  context_packet: ["query", "subjects", "since", "until", "budget_tokens", "include", "purpose", "hooks", "taskEventVersion", "task_integrity", "priorView"],
};
function invalid(): never { throw new ServeError("invalid_arguments", "invalid arguments: invalid scoped input"); }
/** Validate every reference's grammar before looking up any reference. */
export function normalizeReadArgs(ctx: ServeContext, tool: Tool, input: object, contract: ResponseContract): { ctx: ServeContext; args: Record<string, unknown>; anchor?: GraphAnchorV2 } {
  if (contract !== ENVELOPE_V2_SCHEMA) return { ctx, args: input as Record<string, unknown> };
  const keys = KEYS[tool];
  if (keys === undefined || Object.keys(input).some(key => !keys.includes(key))) invalid();
  const args = { ...input } as Record<string, unknown>;
  const refs = new Map<string, ScopedRef[]>();
  for (const key of ["page", "subject", "subjects", "source", "eventVersion", "anchor", "taskEventVersion"]) {
    if (args[key] === undefined) continue;
    const values = key === "subjects" ? args[key] : [args[key]];
    if (!Array.isArray(values) || values.length > 16) invalid();
    refs.set(key, values.map(requireScopedRef));
  }
  if (tool === "get_page" && !refs.has("page") || tool === "graph_neighbors" && !refs.has("anchor")) invalid();
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx);
    let selection: EvidenceSelection | undefined;
    let anchor: GraphAnchorV2 | undefined;
    const raw = (value: ScopedRef): RawSubjectRef => resolveRawSubjectRef(scope, value) ?? (() => { throw missingReference(); })();
    for (const [key, values] of refs) {
      delete args[key];
      const value = values[0];
      if (key === "subjects" || key === "subject") {
        const subjects = values.map(raw);
        selection = { ...selection, subjects };
        args[key] = key === "subject" ? subjects[0]!.id : subjects.map(subject => subject.id);
      } else if (key === "page") {
        const page = resolvePageRef(scope, value!);
        if (page === null) throw missingReference();
        args.id = page.id;
      } else if (key === "source") {
        const source = resolveSourceRef(scope, value!);
        if (source === null) throw missingReference();
        selection = { ...selection, source };
      } else if (key === "eventVersion" || key === "taskEventVersion") {
        const id = resolveEventVersionRef(scope, value!);
        if (id === null) throw missingReference();
        args[key === "eventVersion" ? "event_id" : "task_event_id"] = id;
      } else {
        if (value!.kind === "page") {
          const page = resolvePageRef(scope, value!); if (page === null) throw missingReference(); args.id = page.id;
        } else if (value!.kind === "event_version") {
          const event = resolveEventVersionRef(scope, value!); if (event === null) throw missingReference(); args.id = event;
        } else if (value!.kind === "raw_subject") {
          const subject = raw(value!); selection = { ...selection, subjects: [subject] }; args.id = subject.id;
        } else throw missingReference();
        anchor = value as GraphAnchorV2;
      }
    }
    // Existing engines cannot express qualified raw filters. Use the existing
    // SQLite floor with the filter before its LIMIT; keep the engine unchanged.
    const selected: ServeContext = { ...scope.ctx, scopedResponse: true, ...(selection === undefined ? {} : { selection }) };
    if (selection !== undefined) delete selected.retrieval;
    return { ctx: selected, args, ...(anchor === undefined ? {} : { anchor }) };
  }).immediate();
}
