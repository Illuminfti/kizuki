import { ATLAS_PANELS, ATLAS_OBJECT_OPERATIONS, type Atlas, type AtlasPanelName, type AtlasObjectOperation } from "@kizuki/core/world";
import { isWorldWireToken } from "@kizuki/core";
import { clean } from "../../../output";
import { temporalInput, coverageLine, KNOWN_OPTIONS, KNOWN_BOUNDS } from "./shared";
import { relationLines } from "./relation-render";
import type { WorldCliOp } from "./types";

export const atlasCli: WorldCliOp<Atlas> = {
  usage: "[--panel home|resume|changed|people|questions|commitments|stale|corrections] [--focus-operation KIND --ref TOKEN --baseline-view TOKEN]",
  options: ["--panel", "--focus-operation", "--ref", "--baseline-view", "--card", ...KNOWN_OPTIONS],
  bounds: { ...KNOWN_BOUNDS, "--card": "kizuki.situation-card/v2 for a situation baseline", "--panel": ATLAS_PANELS.join(", "), "--focus-operation": ATLAS_OBJECT_OPERATIONS.join(", "), "--ref": "43 character object token", "--baseline-view": "43 character retained view token" },
  buildInput: options => {
    const panel = options.get("--panel") ?? "home", operation = options.get("--focus-operation"), token = options.get("--ref"), baseline = options.get("--baseline-view"), when = temporalInput(options), card = options.get("--card");
    if (!when || !ATLAS_PANELS.includes(panel as AtlasPanelName)) return null;
    if (operation !== undefined || token !== undefined || baseline !== undefined || card !== undefined) {
      if (!operation || !ATLAS_OBJECT_OPERATIONS.includes(operation as AtlasObjectOperation) || !token || !isWorldWireToken(token) || !baseline || !isWorldWireToken(baseline) || !["home", "changed", "corrections"].includes(panel) || (card !== undefined && (operation !== "situation" || card !== "kizuki.situation-card/v2"))) return null;
      return { panel, focus: { operation, ref: { kind: "object", token }, ...(card ? {card} : {}) }, baselineView: { kind: "view", token: baseline }, ...when };
    }
    return { panel, ...when };
  },
  render: data => ["Atlas", ...data.panels.flatMap(panel => [
    `${panel.title}: ${panel.status}${panel.reason ? ` (${panel.reason})` : ""}`, coverageLine(panel.coverage),
    ...panel.entries.flatMap(entry => [clean(entry.title), ...entry.facts.map(fact => `${clean(fact.label)}: ${clean(fact.value)}`), ...entry.relations.flatMap(item => relationLines(item))]),
    ...(panel.change ? ["Visible differences; changes are not necessarily caused by corrections.", ...panel.change.added.map(one => `Added claim: ${one.token}`), ...panel.change.removed.map(one => `Removed claim: ${one.token}`), ...panel.change.changed.map(one => `Changed claim: ${one.claim.token}; ${one.fields.join(", ")}`), ...(panel.change.truncated ? ["Differences were bounded; more may exist."] : [])] : []),
    ...(panel.nextView ? [`Next baseline view: ${panel.nextView.token}`] : []),
  ]), coverageLine(data.coverage)],
};
