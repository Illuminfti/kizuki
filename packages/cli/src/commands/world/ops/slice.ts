import type { WorldSlice } from "@kizuki/core/world";
import { clean } from "../../../output";
import { relationLines } from "./relation-render";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, temporalInput, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";

export const sliceCli: WorldCliOp<WorldSlice> = {
  usage: "--task TEXT --budget-tokens N [--kinds concept,situation] [--prior-view TOKEN] [--valid-at TIME]",
  options: ["--task", "--budget-tokens", "--kinds", ...KNOWN_OPTIONS],
  bounds: { ...KNOWN_BOUNDS, "--task": "at most 512 UTF-8 bytes", "--budget-tokens": "50 to 2000", "--kinds": "1 to 16 distinct kind ids, comma separated" },
  buildInput: options => {
    const task = options.get("--task"), raw = options.get("--budget-tokens"), when = temporalInput(options), kinds = options.get("--kinds");
    if (task === undefined || Buffer.byteLength(task, "utf8") > 512 || raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 50 || Number(raw) > 2000 || when === null) return null;
    const selected = kinds?.split(",");
    if (selected !== undefined && (selected.length > 16 || selected.some(value => !/^[a-z][a-z0-9_]{0,47}$/.test(value)) || new Set(selected).size !== selected.length)) return null;
    return { task, budgetTokens: Number(raw), ...(selected === undefined ? {} : { kinds: selected }), ...when };
  },
  render: data => [
    `Task: ${clean(data.task)}`, `Slice: ${data.complete ? "complete for this query" : "incomplete"}; ${data.tokens} body tokens; ${data.truncated ? "bounded result" : "not truncated"}.`,
    ...data.providers.map(provider => `${provider.kind}: ${provider.status}${provider.status === "unavailable" ? ` (${provider.reason})` : ""}`),
    ...data.constraints.flatMap(item => relationLines(item.relation, "Constraint")),
    ...data.detail.flatMap(item => relationLines(item.relation, "Detail")), coverageLine(data.coverage),
  ],
};
