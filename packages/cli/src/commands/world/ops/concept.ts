import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { CURRENT, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";

export const conceptCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.concept-card/v1" }>> = {
  usage: "--ref TOKEN",
  options: ["--ref"],
  bounds: { "--ref": "32-byte base64url object token" },
  buildInput: (options) => {
    const ref = options.get("--ref");
    return ref === undefined || !isWorldWireToken(ref)
      ? null
      : { concept: { kind: "object", token: ref }, ...CURRENT };
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
