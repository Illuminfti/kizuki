import { z } from "zod";
import { conceptFragment } from "./concept";
import { situationFragment } from "./situation";
import { personFragment } from "./person";
import { procedureFragment, skillFragment, frameworkFragment } from "./skills";
import { artifactFragment } from "./artifact";
import { questionFragment } from "./question";
import { WIRE_TOKEN } from "./shared";
import type { McpWorldOp } from "./types";

export const shareFragment: McpWorldOp = {
  name: "share",
  fields: { of: z.record(z.string(), z.unknown()).optional() },
  data: { "kizuki.resume-handle/v1": { handle: WIRE_TOKEN, expiresAt: z.string() } },
  summary: "share: of:{operation,objectField:ref}; handle carries no authority.",
};
export const resumeFragment: McpWorldOp = {
  name: "resume",
  fields: { handle: WIRE_TOKEN.optional() },
  data: { ...conceptFragment.data, ...situationFragment.data, ...questionFragment.data, ...personFragment.data, ...procedureFragment.data, ...skillFragment.data, ...frameworkFragment.data, ...artifactFragment.data },
  summary: "resume: handle under your grant; priorView never renews expiry.",
};
