import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";
import { relationLines } from "./relation-render";

const LABELS: Readonly<Record<string, string>> = {
  "situation.objective": "Objective",
  "situation.blocker": "Blocker",
  "situation.change": "Recent change",
  "situation.commitment": "Commitment",
};

export const situationCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.situation-card/v1" | "kizuki.situation-card/v2" }>> = {
  usage: "--ref TOKEN [--card kizuki.situation-card/v2] [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--ref", "--card", ...KNOWN_OPTIONS],
  bounds: { ...KNOWN_BOUNDS, "--card": "kizuki.situation-card/v2 (optional)", "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const ref = options.get("--ref"), when = temporalInput(options), card = options.get("--card");
    return ref === undefined || !isWorldWireToken(ref) || when === null || (card !== undefined && card !== "kizuki.situation-card/v2")
      ? null
      : { situation: { kind: "object", token: ref }, ...when, ...(card === undefined ? {} : {card}) };
  },
  render: (data) => [
    clean(data.situation.labels.map((label) => label.text).join(" / ")) || "Situation",
    `Identity: ${data.situation.resolution}; object: ${data.situation.ref.token}; classification: ${data.situation.classificationClaims.map((ref) => ref.token).join(", ")}.`,
    ...[["Objective", data.objective], ["Blocker", data.blocker], ["Recent change", data.recentChange]].flatMap(([label, value]) => value === null ? [`${label}: unknown.`] : []),
    ...[...new Map([data.objective, data.blocker, data.recentChange, ...(data.schema === "kizuki.situation-card/v1" ? data.commitments : data.statedCommitments), ...data.uncertainty]
      .flatMap((item) => item === null ? [] : [[item.claim.token, item] as const])).values()]
      .flatMap((item) => relationLines(item, LABELS[item.predicate] ?? item.predicate)),
    ...(data.schema === "kizuki.situation-card/v1" ? [] : [
      ...data.commitments.flatMap(c => [
        `Commitment: ${c.commitment.token}; status: ${c.status}; overdue: ${c.overdue}.`,
        ...[c.label,...c.debtor,...c.creditor,...c.due,...c.deliverable].flatMap(r => r === null ? [] : relationLines(r,r.predicate)),
        `Status evidence: ${c.statusBasis.map(ref => ref.token).join(", ") || "none observed"}.`,
      ]),
      ...data.decisions.flatMap(d => [`Decision: ${d.decision.token}; status: ${d.status}.`,...relationLines(d.statement,"Decision")]),
      ...data.dependencies.flatMap(d => relationLines(d.relation,d.predicate)),
    ]),
    `Participants: ${data.participants.map((ref) => ref.token).join(", ") || "none observed"}.`,
    `Known at: ${data.knownAt.kind}; summary: ${data.summary === null ? "unavailable" : clean(data.summary.text)}.`,
    ...(data.summary === null ? [] : [`Summary evidence: ${data.summary.admissions.map((ref) => ref.token).join(", ")}.`]),
    coverageLine(data.coverage),
  ],
};
