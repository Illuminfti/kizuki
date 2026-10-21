import type { SituationCard } from "./situation-card";
import { cardCodec, coverage, exact, knowledgeNode, knownAt, objectRefList, optionalRelation, relation, relationList, summary, wireRef, type Relation, type WorldWireRef } from "./world-card-kit";
import { isPlainObject } from "../util/validate";

export const SITUATION_CARD_V2_SCHEMA = "kizuki.situation-card/v2" as const;
export type CommitmentStatus = "open" | "claimed_done" | "done" | "dropped";
export type CommitmentEntry = {
  readonly commitment: WorldWireRef<"object">;
  readonly label: Relation | null;
  readonly debtor: readonly Relation[];
  readonly creditor: readonly Relation[];
  readonly due: readonly Relation[];
  readonly deliverable: readonly Relation[];
  readonly status: CommitmentStatus;
  readonly statusBasis: readonly WorldWireRef<"claim">[];
  readonly overdue: boolean | "unknown";
};
export type DecisionEntry = {
  readonly decision: WorldWireRef<"object">;
  readonly label: Relation | null;
  readonly status: "open" | "decided" | "reversed";
  readonly statement: Relation;
};
export const SITUATION_DEPENDENCIES = ["situation.requires", "situation.enables", "situation.blocks", "situation.invalidated_by"] as const;
export type SituationDependency = {
  readonly predicate: typeof SITUATION_DEPENDENCIES[number];
  readonly from: WorldWireRef<"object">;
  readonly to: WorldWireRef<"object">;
  readonly relation: Relation;
};
export type SituationCardV2 = Omit<SituationCard, "schema" | "commitments"> & {
  readonly schema: typeof SITUATION_CARD_V2_SCHEMA;
  readonly commitments: readonly CommitmentEntry[];
  readonly statedCommitments: readonly Relation[];
  readonly decisions: readonly DecisionEntry[];
  readonly dependencies: readonly SituationDependency[];
};
const list = (v: unknown, check: (v: unknown) => boolean) => Array.isArray(v) && v.length <= 128 && v.every(check);
export function commitmentEntry(v: unknown): v is CommitmentEntry {
  return isPlainObject(v) && exact(v, ["commitment","label","debtor","creditor","due","deliverable","status","statusBasis","overdue"])
    && wireRef(v.commitment,"object") && optionalRelation(v.label) && relationList(v.debtor) && relationList(v.creditor)
    && relationList(v.due) && relationList(v.deliverable) && ["open","claimed_done","done","dropped"].includes(v.status as string)
    && list(v.statusBasis, x => wireRef(x,"claim")) && (typeof v.overdue === "boolean" || v.overdue === "unknown");
}
export function decisionEntry(v: unknown): v is DecisionEntry {
  return isPlainObject(v) && exact(v,["decision","label","status","statement"]) && wireRef(v.decision,"object")
    && optionalRelation(v.label) && ["open","decided","reversed"].includes(v.status as string) && relation(v.statement)
    && v.statement.predicate === "decision.status" && v.statement.polarity === "positive" && v.statement.perspective.mode === "asserted"
    && v.statement.object.kind === "vocabulary" && v.statement.object.id === `decision/${v.status}`;
}
export function situationDependency(v: unknown): v is SituationDependency {
  return isPlainObject(v) && exact(v,["predicate","from","to","relation"]) && SITUATION_DEPENDENCIES.includes(v.predicate as SituationDependency["predicate"])
    && wireRef(v.from,"object") && wireRef(v.to,"object") && relation(v.relation) && v.relation.predicate === v.predicate
    && v.relation.subject.token === v.from.token && v.relation.object.kind === "node" && v.relation.object.ref.token === v.to.token;
}
export const validateSituationCardV2 = cardCodec<SituationCardV2,"situation-card-v2">({
  schema: SITUATION_CARD_V2_SCHEMA, label: "situation-card-v2", fields: {
    situation: v => knowledgeNode(v,"situation"), summary, objective: optionalRelation, participants: objectRefList,
    commitments: v => list(v,commitmentEntry), statedCommitments: relationList, decisions: v => list(v,decisionEntry),
    dependencies: v => list(v,situationDependency), blocker: optionalRelation, recentChange: optionalRelation,
    uncertainty: relationList, knownAt, coverage,
  },
});
