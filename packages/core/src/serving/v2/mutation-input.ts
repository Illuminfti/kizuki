import { isPlainObject } from "../../util/validate";
import { assertScopedWriterAvailable } from "./writer-refusal";
import { snapshotScopedInput } from "./input-snapshot";
import { canonicalJson } from "../../util/hash";
import { readClaimV2Semantic } from "../../claims/claim-v2-commit";
import type { RawSubjectRef } from "../../contracts/claim-v2";
import type { ScopedRef, RawSubjectWireRef, PageRef, ClaimGroupRef } from "../../contracts/scoped-refs";
import type { ScopedMutationObject } from "../../contracts/scoped-tools";
import { referenceScope, requireScopedRef, missingReference } from "../../world/ref-kinds/common";
import { resolvePageRef } from "../../world/ref-kinds/page";
import { resolveRawSubjectRef } from "../../world/ref-kinds/raw-subject";
import { resolveEventVersionRef } from "../../world/ref-kinds/evidence";
import { resolveClaimRef, resolveClaimGroupRef } from "../../world/ref-kinds/claim";
import { readableWorldNode } from "../../world/endpoint-access";
import type { EvidenceSelection } from "../../query/selection";
import type { ProposeArgs } from "../propose";
import type { CorrectArgs } from "../correct";
import { parseObject } from "../correct-args";
import { ENVELOPE_V2_SCHEMA, ServeError, type ServeContext, type ResponseContract } from "../types";

export type ProposeArgsV2 = Omit<ProposeArgs, "target" | "subject" | "subjects" | "provenance" | "object"> & {
  target?: PageRef | null; subject?: RawSubjectWireRef | ScopedRef<"object">;
  subjects?: RawSubjectWireRef[]; provenance: ScopedRef<"event_version">[]; object?: ScopedMutationObject;
};
export type CorrectArgsV2 = Omit<CorrectArgs, "target" | "object" | "refresh_world"> & {
  target?: ScopedRef<"claim"> | ClaimGroupRef | RawSubjectWireRef; object?: ScopedMutationObject;
  refreshWorld?: Extract<import("../world-view").WorldReadInput, { operation: "concept" | "history" }>;
};
const PROPOSE = ["kind", "target", "subject", "subjects", "provenance", "object", "body", "frontmatter", "predicate", "polarity", "confidence"];
const CORRECT = ["statement", "target", "object", "dry_run", "mode", "perspective_mode", "refreshWorld"];
function invalid(): never { throw new ServeError("invalid_arguments", "invalid arguments: invalid scoped mutation"); }
type Normalized<A> = { args: A; ctx: ServeContext; subjectIdentity?: RawSubjectRef; assertCurrent?: () => void; refresh?: Record<string, unknown> };
export function normalizeMutationArgs(ctx: ServeContext, tool: "propose", input: ProposeArgs | ProposeArgsV2, contract: ResponseContract): Normalized<ProposeArgs>;
export function normalizeMutationArgs(ctx: ServeContext, tool: "correct", input: CorrectArgs | CorrectArgsV2, contract: ResponseContract): Normalized<CorrectArgs>;
export function normalizeMutationArgs(ctx: ServeContext, tool: "propose" | "correct", input: object, contract: ResponseContract): Normalized<ProposeArgs | CorrectArgs> {
  if (contract !== ENVELOPE_V2_SCHEMA) return { args: input as ProposeArgs | CorrectArgs, ctx };
  const data = snapshotScopedInput(input), keys = tool === "propose" ? PROPOSE : CORRECT;
  if (Object.keys(data).some(key => !keys.includes(key))) invalid();
  const refs = new Map<string, ScopedRef[]>();
  for (const key of tool === "propose" ? ["target", "subject", "subjects", "provenance"] : ["target"]) {
    if (data[key] === undefined || key === "target" && data[key] === null && tool === "propose") continue;
    const values = key === "subjects" || key === "provenance" ? data[key] : [data[key]];
    if (!Array.isArray(values) || values.length > (key === "provenance" ? 64 : 16)) invalid();
    refs.set(key, values.map(requireScopedRef));
  }
  if (tool === "propose" && (!refs.has("provenance") || refs.get("provenance")!.length === 0)) invalid();
  const object = data.object === undefined ? undefined : typeof data.object === "string" ? invalid() : parseObject(data.object);
  // The existing proposal writer stores legacy literal claims. It cannot
  // faithfully admit a rich relation without a complete checked world support.
  if (tool === "propose" && object !== undefined && object.kind !== "literal") invalid();
  const refresh = data.refreshWorld === undefined ? undefined : snapshotScopedInput(data.refreshWorld);
  if (refresh !== undefined && refresh.operation !== "concept" && refresh.operation !== "history") invalid();
  function resolve() {
    const scope = referenceScope(ctx), args: Record<string, unknown> = { ...data };
    delete args.refreshWorld;
    let selection: EvidenceSelection | undefined;
    let subjectIdentity: RawSubjectRef | undefined;
    const raw = (value: ScopedRef): RawSubjectRef => {
      const result = value.kind === "object" && tool === "propose" ? readableWorldNode(scope.ctx, scope.ns, value.token) : resolveRawSubjectRef(scope, value);
      if (result === null) throw missingReference();
      return result;
    };
    for (const [key, values] of refs) {
      if (key === "provenance") args[key] = values.map(value => resolveEventVersionRef(scope, value) ?? (() => { throw missingReference(); })());
      else if (key === "subjects" || key === "subject") {
        if (key === "subjects" && values.some(value => value.kind !== "raw_subject")) throw missingReference();
        const subjects = values.map(raw); args[key] = key === "subjects" ? subjects.map(value => value.id) : subjects[0]!.id;
        selection = { subjects: [...(selection?.subjects ?? []), ...subjects] };
        // Match subjectOf: an explicit subject wins; otherwise the first
        // subjects entry supplies the claim's qualified identity.
        if (key === "subject" || !refs.has("subject")) subjectIdentity = subjects[0];
      } else if (tool === "propose") {
        const page = resolvePageRef(scope, values[0]!); if (page === null) throw missingReference(); args.target = page.id;
      } else {
        const value = values[0]!;
        if (value.kind === "claim") {
          const claim = resolveClaimRef(scope, value); if (claim === null) throw missingReference();
          args.target = readClaimV2Semantic(ctx.db, claim.claim_id) === null ? { claim_id: claim.claim_id } : { world_claim: value };
        } else if (value.kind === "claim_group") {
          const claims = resolveClaimGroupRef(scope, value);
          const key = claims?.[0]?.claim_key;
          if (claims === null || key === null || key === undefined || claims.some(claim => claim.claim_key !== key)) throw missingReference();
          args.target = { claim_key: key };
          selection = { claimIds: claims.map(claim => claim.claim_id) };
        } else if (value.kind === "raw_subject") {
          const subject = raw(value); args.target = { subject: subject.id }; selection = { subjects: [subject] };
        } else throw missingReference();
      }
    }
    if (object !== undefined) {
      if (object.kind === "node" && readableWorldNode(scope.ctx, scope.ns, object.ref.token) === null) throw missingReference();
      const typedTarget = tool === "correct" && isPlainObject(args.target) && Object.hasOwn(args.target, "world_claim");
      if (object.kind !== "literal" && !typedTarget) invalid();
      args.object = tool === "propose" || !typedTarget ? object.kind === "literal" ? object.value : invalid() : object;
    }
    return { args: args as unknown as ProposeArgs | CorrectArgs, ctx: { ...scope.ctx, scopedResponse: true as const, ...(selection === undefined ? {} : { selection }) }, ns: scope.ns.id, subjectIdentity };
  }
  const initial = ctx.db.transaction(resolve).immediate();
  const baseline = canonicalJson({ args: initial.args, selection: initial.ctx.selection ?? null, subjectIdentity: initial.subjectIdentity ?? null, ns: initial.ns });
  const assertCurrent = (): void => {
    assertScopedWriterAvailable(ctx.db);
    const current = resolve();
    if (canonicalJson({ args: current.args, selection: current.ctx.selection ?? null, subjectIdentity: current.subjectIdentity ?? null, ns: current.ns }) !== baseline) throw missingReference();
  };
  return { args: initial.args, ctx: initial.ctx, ...(initial.subjectIdentity === undefined ? {} : { subjectIdentity: initial.subjectIdentity }), assertCurrent, ...(refresh === undefined ? {} : { refresh }) };
}
