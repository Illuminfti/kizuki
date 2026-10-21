import { WORLD_DIFF_SCHEMA } from "../../contracts/world-diff";
import { isPlainObject } from "../../util/validate";
import { hasWorldKeys, parseWorldRef } from "./parse";
import type { WorldOpFactory } from "./registry";
import type { ClaimsOp, WorldRecord } from "./types";

export const diffOp: WorldOpFactory = (ops) => {
  const targets = ops.filter((op): op is ClaimsOp => op.source === "claims" && op.readObject !== undefined && op.views === true);
  return {
    source: "claims", name: "diff", views: true, knownAt: true,
    keys: { required: ["of"], optional: [] },
    dataSchemas: [WORLD_DIFF_SCHEMA, ...new Set(targets.flatMap(op => op.dataSchemas))],
    parse: ({ of, priorView }) => {
      if (!isPlainObject(of) || parseWorldRef(priorView, "view") === null) return null;
      const target = targets.find(op => op.name === of.operation);
      if (target === undefined || target.keys.required.length !== 1 ||
        !hasWorldKeys(of, ["operation", ...target.keys.required], []) || target.parse(of) === null) return null;
      return of;
    },
    run: (frame, of, when) => {
      const target = targets.find(op => op.name === of.operation)!;
      if (when.knownAt.kind !== "current" && target.knownAt !== true) return { status: "unavailable", reason: "history" };
      // Return the fresh card, including its incomplete states. The shared
      // view reader retains that projection and compares its qualified claims.
      return target.run(frame, target.parse(of), when);
    },
  } satisfies ClaimsOp<WorldRecord>;
};
