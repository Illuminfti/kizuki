import { discoverWorld } from "../projection";
import { resolveWorldObject } from "../references";
import { coveredOutcome } from "./outcome";
import { isWorldWireToken } from "./parse";
import { WorldViewError } from "./types";
import type { ClaimsOp } from "./types";

interface Discovery {
  readonly label: string;
  readonly cursor: string | null;
}

function discoveryOp(
  kind: "concept" | "situation",
): ClaimsOp<Discovery> {
  return {
    source: "claims",
    name: `find_${kind}s`,
    keys: { required: ["label"], optional: ["cursor"] },
    dataSchemas: [`kizuki.${kind}-matches/v1`],
    views: true,
    parse: (input) => {
      const { label, cursor } = input;
      if (typeof label !== "string" || label.length > 200) return null;
      if (!Object.hasOwn(input, "cursor")) return { label, cursor: null };
      return typeof cursor === "string" && isWorldWireToken(cursor)
        ? { label, cursor }
        : null;
    },
    run: ({ ctx, ns, dependencies }, { label, cursor }, { valid }) => {
      // A cursor is an object reference this principal was issued for the last match of the previous page.
      const after =
        cursor === null ? null : resolveWorldObject(ctx.db, ns, cursor);
      if (cursor !== null && after === null) throw new WorldViewError();
      return coveredOutcome(discoverWorld(ctx, ns, kind, label, valid, after, undefined, dependencies));
    },
  };
}

export const discoverConceptsOp = discoveryOp("concept");
export const discoverSituationsOp = discoveryOp("situation");
