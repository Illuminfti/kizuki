import { ATLAS_SCHEMA, ATLAS_PANELS, ATLAS_OBJECT_OPERATIONS, type AtlasObjectOperation, type AtlasPanelName } from "../../contracts/atlas";
import { isPlainObject } from "../../util/validate";
import { compileAtlas, type AtlasQuery } from "../atlas/compile";
import { hasWorldKeys, parseWorldRef } from "./parse";
import { coveredOutcome } from "./outcome";
import type { ClaimsOp } from "./types";

export const atlasOp: ClaimsOp<AtlasQuery> = {
  source: "claims", name: "atlas", keys: { required: [], optional: ["panel", "focus", "baselineView"] }, dataSchemas: [ATLAS_SCHEMA],
  parse: input => {
    const panel = Object.hasOwn(input, "panel") ? input.panel : "home";
    if (!ATLAS_PANELS.includes(panel as AtlasPanelName)) return null;
    let focus: AtlasQuery["focus"] = null;
    if (Object.hasOwn(input, "focus")) {
      if (!isPlainObject(input.focus) || !hasWorldKeys(input.focus, ["operation", "ref"], ["card"]) || !ATLAS_OBJECT_OPERATIONS.includes(input.focus.operation as AtlasObjectOperation)) return null;
      const ref = parseWorldRef(input.focus.ref, "object");
      if (!ref || (Object.hasOwn(input.focus, "card") && (input.focus.operation !== "situation" || input.focus.card !== "kizuki.situation-card/v2"))) return null;
      focus = { operation: input.focus.operation as AtlasObjectOperation, ref, ...(input.focus.card === "kizuki.situation-card/v2" ? { card: "kizuki.situation-card/v2" as const } : {}) };
    }
    const baselineView = Object.hasOwn(input, "baselineView") ? parseWorldRef(input.baselineView, "view") : null;
    if ((Object.hasOwn(input, "baselineView") && !baselineView) || (!!focus !== !!baselineView) || (focus && !["home", "changed", "corrections"].includes(String(panel)))) return null;
    return { panel: panel as AtlasPanelName, focus, baselineView };
  },
  run: (frame, query, when) => {
    const { data, quoted } = compileAtlas(frame, query, when);
    return { ...coveredOutcome(data), quoted };
  },
};
