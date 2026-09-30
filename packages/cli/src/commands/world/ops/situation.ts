import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { CURRENT, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";
import { relationLines } from "./relation-render";

const LABELS: Readonly<Record<string, string>> = {
  "situation.objective": "Objective",
  "situation.blocker": "Blocker",
  "situation.change": "Recent change",
  "situation.commitment": "Commitment",
};

export const situationCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.situation-card/v1" }>> = {
  usage: "--ref TOKEN",
  options: ["--ref"],
  bounds: { "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const ref = options.get("--ref");
    return ref === undefined || !isWorldWireToken(ref)
      ? null
      : { situation: { kind: "object", token: ref }, ...CURRENT };
  },
  render: (data) => [
    clean(data.situation.labels.map((label) => label.text).join(" / ")) || "Situation",
    `Identity: ${data.situation.resolution}; object: ${data.situation.ref.token}; classification: ${data.situation.classificationClaims.map((ref) => ref.token).join(", ")}.`,
    ...[["Objective", data.objective], ["Blocker", data.blocker], ["Recent change", data.recentChange]].flatMap(([label, value]) => value === null ? [`${label}: unknown.`] : []),
    ...[...new Map([data.objective, data.blocker, data.recentChange, ...data.commitments, ...data.uncertainty]
      .flatMap((item) => item === null ? [] : [[item.claim.token, item] as const])).values()]
      .flatMap((item) => relationLines(item, LABELS[item.predicate] ?? item.predicate)),
    `Participants: ${data.participants.map((ref) => ref.token).join(", ") || "none observed"}.`,
    `Known at: ${data.knownAt.kind}; summary: ${data.summary === null ? "unavailable" : clean(data.summary.text)}.`,
    ...(data.summary === null ? [] : [`Summary evidence: ${data.summary.admissions.map((ref) => ref.token).join(", ")}.`]),
    coverageLine(data.coverage),
  ],
};
