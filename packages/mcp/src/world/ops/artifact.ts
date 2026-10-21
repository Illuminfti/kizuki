import { z } from "zod";
import { CURSOR, LABEL, WIRE_TOKEN, WORLD_OBJECT_REF, worldCoverage, worldCommon, worldNode, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";
export const artifactFragment: McpWorldOp = { name: "artifact_version", fields: { artifact: WORLD_OBJECT_REF.optional() }, data: { "kizuki.artifact-card/v1": {
      artifact: worldNode("artifact_version"), versionOf: worldRelation.nullable(),
      content: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), mediaType: z.string().max(128).nullable(), byteLength: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }),
      original: z.strictObject({ status: z.enum(["unavailable", "external"]) }), inspections: z.array(worldRelation).max(256), knownAt: worldCommon.knownAt, coverage: worldCoverage,
    } }, summary: "artifact_version: exact metadata/feedback; external original is not inspected." };
export const findArtifactsFragment: McpWorldOp = { name: "find_artifacts", fields: { label: LABEL, cursor: CURSOR }, data: { "kizuki.artifact_version-matches/v1": {
      matches: z.array(z.strictObject({ ref: WORLD_OBJECT_REF, labels: z.array(z.string().max(400)).max(256) })).max(32), cursor: WIRE_TOKEN.nullable(), coverage: worldCoverage,
    } }, summary: "find_artifacts: scoped version label pages." };
