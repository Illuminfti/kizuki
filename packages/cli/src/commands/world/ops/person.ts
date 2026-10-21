import { isWorldWireToken, type PersonCard } from "@kizuki/core/world";
import { clean } from "../../../output";
import { discoverCli } from "./discover";
import { relationLines } from "./relation-render";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, coverageLine, temporalInput } from "./shared";
import type { WorldCliOp } from "./types";
export const personCli: WorldCliOp<PersonCard> = {
  usage: "--ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--ref", ...KNOWN_OPTIONS], bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url person token" },
  buildInput: options => {
    const token = options.get("--ref"), when = temporalInput(options);
    return token === undefined || !isWorldWireToken(token) || when === null ? null : { person: { kind: "object", token }, ...when };
  },
  render: data => [clean(data.person.labels.map(label => label.text).join(" / ")) || "Person",
    `Person: ${data.person.ref.token}; no agreement inferred.`,
    ...data.perspectives.flatMap(group => [
      `Perspective: holder=${group.holder?.token ?? "unattributed"} speaker=${group.speaker?.token ?? "unattributed"} mode=${group.mode}`,
      ...group.relations.flatMap(item => relationLines(item, item.predicate)),
    ]),
    `Summary: ${data.summary === null ? "unavailable" : clean(data.summary.text)}.`, coverageLine(data.coverage)],
};
export const findPeopleCli: typeof discoverCli = {
  ...discoverCli, usage: "[--label TEXT] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN]",
  options: [...discoverCli.options, "--valid-at"], bounds: { ...discoverCli.bounds, "--valid-at": KNOWN_BOUNDS["--valid-at"] },
  buildInput: options => {
    const input = discoverCli.buildInput(options), when = temporalInput(options);
    return input === null || when === null ? null : { ...input, ...when };
  }, notice: () => null,
};
