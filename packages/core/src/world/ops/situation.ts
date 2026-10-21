import { SITUATION_CARD_V2_SCHEMA } from "../../contracts/situation-card-v2";
import { resolveWorldObject } from "../references";
import { readKnownCard } from "../known/reader";
import { NOT_FOUND } from "./outcome";
import { parseWorldRef } from "./parse";
import type { ClaimsOp, WorldObjectRef } from "./types";
const readObject: NonNullable<ClaimsOp["readObject"]> = (frame,handle,when) => readKnownCard(frame,handle,"situation",when);
export const situationOp: ClaimsOp<{ ref: WorldObjectRef; card?: typeof SITUATION_CARD_V2_SCHEMA }> = {
  source: "claims", name: "situation", keys: { required: ["situation"], optional: ["card"] },
  dataSchemas: ["kizuki.situation-card/v1",SITUATION_CARD_V2_SCHEMA], views: true, knownAt: true, readObject,
  parse: input => {
    const ref = parseWorldRef(input.situation,"object");
    if (ref === null || (Object.hasOwn(input,"card") && input.card !== SITUATION_CARD_V2_SCHEMA)) return null;
    return { ref, ...(input.card === SITUATION_CARD_V2_SCHEMA ? {card: SITUATION_CARD_V2_SCHEMA} : {}) };
  },
  run: (frame,{ref,card},when) => {
    const handle = resolveWorldObject(frame.ctx.db,frame.ns,ref.token);
    return handle === null ? (when.knownAt.kind === "snapshot" ? {status:"new_view_required"} : NOT_FOUND)
      : readKnownCard(frame,handle,"situation",when,card);
  },
};
