import { isWorldWireToken } from "@kizuki/core/world";
import type { WorldData } from "@kizuki/core/world";
import { clean } from "../../../output";
import { CURRENT, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";
import { relationLines } from "./relation-render";

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
    `Identity: ${data.concept.resolution}; object: ${data.concept.ref.token}; classification: ${data.concept.classificationClaims.map((ref) => ref.token).join(", ")}.`,
    ...data.definitions.flatMap((definition) => relationLines(definition, "Definition")),
    ...data.relations.flatMap((relation) => relationLines(relation)),
    ...data.learning.flatMap((learning) => [
      `Learning: ${learning.facet}; assistance: ${learning.assistance}.`,
      ...relationLines(learning.assertion),
      ...learning.assistanceEvidence.flatMap((relation) => relationLines(relation, "Assistance evidence")),
    ]),
    `Known at: ${data.knownAt.kind}; summary: ${data.summary === null ? "unavailable" : clean(data.summary.text)}.`,
    ...(data.summary === null ? [] : [`Summary evidence: ${data.summary.admissions.map((ref) => ref.token).join(", ")}.`]),
    coverageLine(data.coverage),
  ],
};
