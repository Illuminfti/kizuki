import type { WorldData } from "@kizuki/core/world";
import { table } from "../../../output";
import type { WorldCliOp } from "./types";

export const describeCli: WorldCliOp<Extract<WorldData, { schema: "kizuki.world-describe/v1" }>> = {
  usage: "",
  options: [],
  bounds: {},
  buildInput: () => ({}),
  render: (data) => [
    `Vocabulary: ${data.vocabulary}`,
    "Kinds:",
    ...data.kinds.map((kind) => `${kind.id}  ${kind.state}  ${kind.population}`),
    "Operations:",
    ...table(data.operations.map((op) => [op.name, op.inputKeys.join(",")])),
  ],
};
