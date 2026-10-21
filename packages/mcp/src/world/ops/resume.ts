import { z } from "zod";
import { conceptFragment } from "./concept";
import { situationFragment } from "./situation";
import { personFragment } from "./person";
import { procedureFragment, skillFragment, frameworkFragment } from "./skills";
import { questionFragment } from "./question";
import { WIRE_TOKEN } from "./shared";
import type { McpWorldOp } from "./types";

export const shareFragment: McpWorldOp = {
  name: "share",
  fields: { of: z.record(z.string(), z.unknown()).optional() },
  data: { "kizuki.resume-handle/v1": { handle: WIRE_TOKEN, expiresAt: z.string() } },
  summary: "share takes of:{operation:concept|situation|question|person, concept|situation|question|person:objectRef} and returns a portable handle with no authority.",
};
export const resumeFragment: McpWorldOp = {
  name: "resume",
  fields: { handle: WIRE_TOKEN.optional() },
  data: { ...conceptFragment.data, ...situationFragment.data, ...questionFragment.data, ...personFragment.data, ...procedureFragment.data, ...skillFragment.data, ...frameworkFragment.data },
  summary: "resume reads the shared object under your own grant; narrower scope adds the coverage gap. priorView can test a complete baseline without extending its lifetime.",
};
