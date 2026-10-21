import { isWorldWireToken, type QuestionCard, type Frontier } from "@kizuki/core/world";
import { clean } from "../../../output";
import { discoverCli } from "./discover";
import { relationLines } from "./relation-render";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, coverageLine, temporalInput } from "./shared";
import type { WorldCliOp } from "./types";

export const questionCli: WorldCliOp<QuestionCard> = {
  usage: "--ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--ref", ...KNOWN_OPTIONS], bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url question token" },
  buildInput: options => {
    const token = options.get("--ref"), when = temporalInput(options);
    return token === undefined || !isWorldWireToken(token) || when === null ? null : { question: { kind: "object", token }, ...when };
  },
  render: data => [
    clean(data.question.labels.map(label => label.text).join(" / ")) || "Question",
    `Status: ${data.lifecycle.status}; understanding: ${data.understanding}.`,
    `Question: ${data.question.ref.token}; status evidence: ${data.lifecycle.grounds.map(ref => ref.token).join(", ")}.`,
    ...data.texts.flatMap(item => relationLines(item, "Question")),
    ...data.answers.flatMap(item => relationLines(item, "Candidate answer")),
    ...data.statusEvidence.flatMap(item => relationLines(item, "Status evidence")),
    ...data.about.flatMap(item => relationLines(item, "About")),
    ...data.motivations.flatMap(item => relationLines(item, "Motivates")),
    ...data.gaps.flatMap(item => relationLines(item, "Gap")),
    `Summary: ${data.summary === null ? "unavailable" : clean(data.summary.text)}.`, coverageLine(data.coverage),
  ],
};

export const findQuestionsCli: typeof discoverCli = {
  ...discoverCli,
  usage: "[--label TEXT] [--about TOKEN] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN]",
  options: [...discoverCli.options, "--about", "--valid-at"],
  bounds: { ...discoverCli.bounds, "--about": "32-byte base64url object token", "--valid-at": KNOWN_BOUNDS["--valid-at"] },
  buildInput: options => {
    const query = discoverCli.buildInput(options), about = options.get("--about"), when = temporalInput(options);
    if (query === null || when === null || (about !== undefined && !isWorldWireToken(about))) return null;
    return { ...query, ...when, ...(about === undefined ? {} : { about: { kind: "object", token: about } }) };
  },
  notice: () => null,
};
export const frontierCli: WorldCliOp<Frontier> = {
  ...findQuestionsCli,
  render: data => [
    ...data.groups.map(group => `${group.kind}: ${group.questions.map(ref => ref.token).join(", ")}`),
    ...(data.groups.length === 0 ? ["No admitted gaps in this scoped page."] : []),
    coverageLine(data.coverage), ...(data.cursor === null ? [] : [`More questions: --cursor ${data.cursor}`]),
  ],
  notice: () => null,
};
