import { GAP_KINDS } from "../../contracts/world-vocab/question";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import type { QuestionCard } from "../../contracts/question-card";
import type { Coverage, WorldWireRef } from "../../contracts/world-card-kit";
import { issuedOpaqueFields } from "../../util/issued-opaque";
import { populationEnabled } from "../pipeline/assemble";
import { newReadFrame } from "../pipeline/frame";
import { readWorldCard } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import { questionMatches, parseQuestionQuery, type QuestionQuery } from "./find-questions";
import { NOT_FOUND, coveredOutcome } from "./outcome";
import type { ClaimsOp } from "./types";

export type Frontier = {
  readonly schema: "kizuki.frontier/v1";
  readonly groups: readonly { readonly kind: typeof GAP_KINDS[number]; readonly questions: readonly WorldWireRef<"object">[] }[];
  readonly cursor: string | null;
  readonly coverage: Coverage;
};

export const frontierOp: ClaimsOp<QuestionQuery> = {
  source: "claims", name: "frontier", keys: { required: [], optional: ["label", "cursor", "about"] },
  dataSchemas: ["kizuki.frontier/v1"], views: true, parse: parseQuestionQuery,
  run: ({ ctx, ns, dependencies }, query, { valid }) => {
    const frame = newReadFrame(ctx, ns, valid, dependencies), matches = questionMatches(frame, query);
    if (matches === null) return NOT_FOUND;
    const groups = new Map<typeof GAP_KINDS[number], WorldWireRef<"object">[]>();
    const gaps = new Set(matches.coverage.gaps);
    if (!populationEnabled(activeWorldRegistry().kind("question")!)) gaps.add("coverage");
    for (const match of matches.matches) {
      const handle = resolveWorldObject(ctx.db, ns, match.ref.token);
      const card = handle === null ? null : readWorldCard(frame, handle, "question") as QuestionCard | null;
      if (card === null) continue;
      for (const gap of card.coverage.gaps) gaps.add(gap);
      const kinds = new Set<typeof GAP_KINDS[number]>();
      if (card.lifecycle.status === "open" || card.lifecycle.status === "partial") kinds.add("unresolved_question");
      if (card.lifecycle.status === "reopened") kinds.add("contradiction");
      for (const relation of card.gaps) {
        if (relation.polarity !== "positive" || relation.perspective.mode !== "asserted" || relation.object.kind !== "vocabulary") continue;
        const kind = GAP_KINDS.find(value => relation.object.kind === "vocabulary" && relation.object.id === `gap/${value}`);
        if (kind !== undefined) kinds.add(kind);
      }
      for (const kind of kinds) groups.set(kind, [...(groups.get(kind) ?? []), card.question.ref]);
    }
    const data: Frontier = {
      schema: "kizuki.frontier/v1", groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([kind, questions]) => ({ kind, questions })),
      cursor: matches.cursor, coverage: { ...matches.coverage, status: gaps.size === 0 ? "complete_for_query" : "partial", gaps: [...gaps] },
    };
    return coveredOutcome(data.cursor === null ? data : issuedOpaqueFields(data, ["cursor"]));
  },
};
