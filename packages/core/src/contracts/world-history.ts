import { cardCodec, coverage, exact, knownTime, wireRef, type Coverage, type KnownTime, type WorldWireRef } from "./world-card-kit";
import { isPlainObject } from "../util/validate";
import { isRfc3339 } from "../util/time";
export type StateTransition = {
  readonly schema: "kizuki.state-transition/v1";
  readonly claim: WorldWireRef<"claim">;
  readonly causeReceipt: WorldWireRef<"receipt"> | null;
  readonly recordedAt: string;
  readonly before: "absent" | "active" | "retracted" | "superseded";
  readonly after: "active" | "retracted" | "superseded";
  readonly valid: KnownTime;
};
export type HistoryPage = {
  readonly schema: "kizuki.world-history/v1";
  readonly snapshot: WorldWireRef<"snapshot">;
  readonly transitions: readonly StateTransition[];
  readonly coverage: Coverage;
};
function transition(value: unknown): boolean {
  return isPlainObject(value) && exact(value, ["schema", "claim", "causeReceipt", "recordedAt", "before", "after", "valid"])
    && value.schema === "kizuki.state-transition/v1" && wireRef(value.claim, "claim")
    && (value.causeReceipt === null || wireRef(value.causeReceipt, "receipt")) && isRfc3339(value.recordedAt)
    && ["absent", "active", "retracted", "superseded"].includes(value.before as string)
    && ["active", "retracted", "superseded"].includes(value.after as string) && knownTime(value.valid);
}
export const validateHistoryPage = cardCodec<HistoryPage, "world-history">({
  schema: "kizuki.world-history/v1", label: "world-history",
  fields: { snapshot: value => wireRef(value, "snapshot"), transitions: value => Array.isArray(value) && value.length <= 128 && value.every(transition), coverage },
});
