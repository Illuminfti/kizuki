import { selectedClaimSql } from "../query/selection";
import { denyClassesOf } from "../agents";
import { claimReadSql } from "../claims/read-scope";
import type { ServeContext } from "./types";

/** Shared claim policy before candidate loading; selected records still pass claimReader. */
export function authorizedClaimSql(ctx: ServeContext): { sql: string; bindings: (string | number)[] } {
  const policy = claimReadSql(ctx.db, {
    grant: ctx.principal.grant,
    source: {
      owner: ctx.principal.kind === "owner",
      purpose: ctx.sourcePurpose ?? "recall",
      deny_classes: denyClassesOf(ctx.principal.grant),
    },
  });
  const selected = selectedClaimSql(ctx.selection);
  return { sql: `(${policy.sql}) AND (${selected.sql})`, bindings: [...policy.bindings, ...selected.bindings] };
}
