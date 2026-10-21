import { isWorldWireToken, type Observation } from "@kizuki/core/world";
import { clean } from "../../../output";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput } from "./shared";
import type { WorldCliOp } from "./types";
export const observationCli: WorldCliOp<Observation> = {
  usage: "--admission TOKEN | --observation TOKEN",
  options: ["--admission", "--observation", ...KNOWN_OPTIONS],
  bounds: { "--admission": "32-byte base64url admission token", "--observation": "32-byte base64url observation token", ...KNOWN_BOUNDS },
  buildInput(options) {
    const admission = options.get("--admission"), observation = options.get("--observation"), when = temporalInput(options);
    const token = admission ?? observation;
    return (admission === undefined) === (observation === undefined) || token === undefined || !isWorldWireToken(token) || when === null ? null
      : { ref: { kind: admission === undefined ? "observation" : "admission", token }, ...when };
  },
  render: data => [
    `Observation [observation-ref:${data.ref.token}]`,
    `Fidelity: ${clean(data.fidelity)}.`,
    `Occurred: ${data.occurred.kind === "known" ? clean(data.occurred.from) : "unknown"}.`,
    `Admitted: ${clean(data.admittedAt)}.`,
    ...data.attribution.map(item => `Captured ${clean(item.role)} [captured-subject-ref:${item.ref.token}] from ${clean(item.field)}; evidence: ${item.evidence.length}.`),
  ],
};
