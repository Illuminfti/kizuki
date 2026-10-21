import { readForecast } from "../forecast/read";
import { resolveWorldObject } from "../references";
import { parseWorldRef } from "./parse";
import { NOT_FOUND } from "./outcome";
import type { ClaimsOp, WorldObjectRef } from "./types";
export const forecastOp:ClaimsOp<WorldObjectRef>={
  source:"claims",name:"forecast",keys:{required:["commitment"],optional:[]},knownAt:true,dataSchemas:["kizuki.forecast/v1"],
  parse:input=>parseWorldRef(input.commitment,"object"),
  run:(frame,ref,when)=>{const handle=resolveWorldObject(frame.ctx.db,frame.ns,ref.token);return handle===null?NOT_FOUND:readForecast(frame,handle,when);},
};
export const forecastScoresOp:ClaimsOp<true>={
  source:"claims",name:"forecast_scores",keys:{required:[],optional:[]},knownAt:true,dataSchemas:["kizuki.forecast-scores/v1"],
  parse:()=>true,run:(frame,_query,when)=>readForecast(frame,null,when,true),
};
