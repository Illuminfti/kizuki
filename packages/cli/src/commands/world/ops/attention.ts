import type { Attention } from "@kizuki/core/world";
import { coverageLine } from "./shared";
import type { WorldCliOp } from "./types";
export const attentionCli: WorldCliOp<Attention> = {
  usage: "", options: [], bounds: {},
  buildInput: () => ({ valid: { kind: "all" }, knownAt: { kind: "current" } }),
  render: data => [...data.states.map(state => state.state === "candidate"
    ? `${state.cue} ${state.source}: ${state.disposition}${state.snoozedUntil === null ? "" : ` until ${state.snoozedUntil}`} (situation ${state.subject.token})`
    : `${state.state}: ${state.reason}`), coverageLine(data.coverage)],
};
