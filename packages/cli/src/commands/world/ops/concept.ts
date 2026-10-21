import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";

export const conceptCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.concept-card/v1" }>> = {
  usage: "--ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--ref", ...KNOWN_OPTIONS],
  bounds: { ...KNOWN_BOUNDS, "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const ref = options.get("--ref"), when = temporalInput(options);
    return ref === undefined || !isWorldWireToken(ref) || when === null
      ? null
      : { concept: { kind: "object", token: ref }, ...when };
  },
  render: (data) => [
    clean(data.concept.labels.map((label) => label.text).join(" / ")) || "Concept",
    ...data.definitions.map((definition) =>
      definition.object.kind === "literal"
        ? clean(definition.object.value)
        : "Qualified linked definition",
    ),
    coverageLine(data.coverage),
  ],
};
