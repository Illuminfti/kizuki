import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";

const LABELS: Readonly<Record<string, string>> = {
  "situation.objective": "Objective",
  "situation.blocker": "Blocker",
  "situation.change": "Recent change",
  "situation.commitment": "Commitment",
};

export const situationCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.situation-card/v1" }>> = {
  usage: "--ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--ref", ...KNOWN_OPTIONS],
  bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const ref = options.get("--ref"), when = temporalInput(options);
    return ref === undefined || !isWorldWireToken(ref) || when === null
      ? null
      : { situation: { kind: "object", token: ref }, ...when };
  },
  render: (data) => [
    clean(data.situation.labels.map((label) => label.text).join(" / ")) || "Situation",
    ...[data.objective, data.blocker, data.recentChange, ...data.commitments].flatMap((item) =>
      item?.object.kind === "literal"
        ? [`${LABELS[item.predicate] ?? item.predicate}: ${clean(item.object.value)}`]
        : [],
    ),
    coverageLine(data.coverage),
  ],
};
