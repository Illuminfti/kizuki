import { isWorldWireToken } from "@kizuki/core/world";
import { clean } from "../../../output";
import { CURRENT } from "./shared";
import type { WorldCliOp } from "./types";

export const evidenceCli: WorldCliOp = {
  usage: "--admission TOKEN --event-version TOKEN --start-utf16 N --end-utf16 N",
  options: ["--admission", "--event-version", "--start-utf16", "--end-utf16"],
  bounds: { "--admission": "32-byte base64url admission token", "--event-version": "32-byte base64url event-version token", "--start-utf16": "nonnegative safe integer", "--end-utf16": "safe integer greater than start" },
  buildInput: (options) => {
    const admission = options.get("--admission"), event = options.get("--event-version"), start = options.get("--start-utf16"), end = options.get("--end-utf16");
    if (admission === undefined || event === undefined || !isWorldWireToken(admission) || !isWorldWireToken(event) || start === undefined || end === undefined || !/^\d+$/.test(start) || !/^\d+$/.test(end)) return null;
    const from = Number(start), until = Number(end);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || until <= from) return null;
    return { evidence: { admission: { kind: "admission", token: admission }, eventVersion: { kind: "event_version", token: event }, span: { kind: "text", startUtf16: from, endUtf16: until } }, ...CURRENT };
  },
  render: (_data, quoted = []) => quoted.flatMap((chunk) => [
    "Captured evidence (untrusted):", ...chunk.text.split(/\r\n|[\n\r\u0085\u2028\u2029]/).map((line) => `> ${clean(line)}`),
    `Integrity: ${chunk.integrity}; slice: ${chunk.slice_integrity}; returned: ${chunk.returned}${chunk.truncated ? " (truncated)" : ""}.`,
  ]),
};
