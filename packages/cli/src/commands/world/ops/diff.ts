import { activeWorldOps, isWorldWireToken, type WorldDiff } from "@kizuki/core/world";
import { KNOWN_BOUNDS, KNOWN_OPTIONS, temporalInput } from "./shared";
import { resumeCli } from "./resume";
import type { WorldCliOp } from "./types";

export const diffCli: WorldCliOp = {
  usage: "--of-operation OBJECT_OPERATION --ref TOKEN --prior-view TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME]",
  options: ["--of-operation", "--ref", ...KNOWN_OPTIONS],
  bounds: { "--of-operation": "registered object operation", "--ref": "32-byte base64url object token", ...KNOWN_BOUNDS },
  buildInput: options => {
    const operation = options.get("--of-operation"), token = options.get("--ref"), when = temporalInput(options);
    const target = activeWorldOps().find(op => op.name === operation);
    if (target?.source !== "claims" || target.readObject === undefined || target.views !== true || target.keys.required.length !== 1 ||
      token === undefined || !isWorldWireToken(token) || !options.has("--prior-view") || when === null) return null;
    return { of: { operation, [target.keys.required[0]!]: { kind: "object", token } }, ...when };
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
