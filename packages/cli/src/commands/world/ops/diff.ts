import { activeWorldOps, isWorldWireToken, type WorldDiff } from "@kizuki/core/world";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, temporalInput } from "./shared";
import { resumeCli } from "./resume";
import type { WorldCliOp } from "./types";

export const diffCli: WorldCliOp = {
  usage: "--of-operation OBJECT_OPERATION --ref TOKEN --prior-view TOKEN [--card CARD_SCHEMA] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--of-operation", "--ref", "--card", ...KNOWN_OPTIONS],
  bounds: { "--of-operation": "registered object operation", "--ref": "32-byte base64url object token", "--card": "optional target card schema", ...KNOWN_BOUNDS },
  buildInput: options => {
    const operation = options.get("--of-operation"), token = options.get("--ref"), when = temporalInput(options);
    const target = activeWorldOps().find(op => op.name === operation);
    if (target?.source !== "claims" || target.readObject === undefined || target.views !== true || target.keys.required.length !== 1 ||
      token === undefined || !isWorldWireToken(token) || !options.has("--prior-view") || when === null) return null;
    const card = options.get("--card");
    const of = { operation, [target.keys.required[0]!]: { kind: "object", token }, ...(card === undefined ? {} : {card}) };
    if (card !== undefined && !target.keys.optional?.includes("card")) return null;
    return target.parse(of) === null ? null : { of, ...when };
  },
  render: data => {
    if (data.schema !== "kizuki.world-diff/v1") return resumeCli.render(data);
    const diff = data as unknown as WorldDiff;
    return [`World changes${diff.truncated ? " (partial)" : ""}:`,
      ...diff.added.map(claim => `Added claim: ${claim.token}`),
      ...diff.removed.map(claim => `Removed claim: ${claim.token}`),
      ...diff.changed.map(change => `Changed claim: ${change.claim.token}; ${change.fields.join(", ")}`),
      ...(diff.added.length + diff.removed.length + diff.changed.length === 0 ? ["The view changed without a qualified assertion change."] : [])];
  },
};
