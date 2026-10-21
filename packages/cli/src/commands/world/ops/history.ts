import { isWorldWireToken } from "@kizuki/core/world";
import type { HistoryPage } from "@kizuki/core/world";
import { clean } from "../../../output";
import { KNOWN_OPTIONS, KNOWN_BOUNDS, temporalInput, coverageLine } from "./shared";
import type { WorldCliOp } from "./types";
export const historyCli: WorldCliOp<HistoryPage> = {
  usage: "--ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--prior-view TOKEN]",
  options: ["--ref", ...KNOWN_OPTIONS], bounds: { "--ref": "32-byte base64url Concept token", ...KNOWN_BOUNDS },
  buildInput: options => {
    const ref = options.get("--ref"), when = temporalInput(options);
    return ref === undefined || !isWorldWireToken(ref) || when === null ? null : { concept: { kind: "object", token: ref }, ...when };
  },
  render: data => ["Retained Concept history", ...data.transitions.map(row => clean(`${row.recordedAt}: ${row.before} → ${row.after}`)),
    `Snapshot: ${data.snapshot.token}`, coverageLine(data.coverage)],
};
