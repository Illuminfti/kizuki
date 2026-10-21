import { z } from "zod";
import { WORLD_OBJECT_REF, worldCoverage, worldRelation } from "./shared";
import type { McpWorldOp } from "./types";
const panels = ["home", "resume", "changed", "people", "questions", "commitments", "stale", "corrections"] as const;
const operations = ["concept", "situation", "person", "question", "procedure", "skill", "framework", "artifact_version"] as const;
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const view = z.strictObject({ kind: z.literal("view"), token });
const claim = z.strictObject({ kind: z.literal("claim"), token });
const entry = z.strictObject({ ref: WORLD_OBJECT_REF.nullable(), operation: z.enum(operations).nullable(), title: z.string().max(400), relations: z.array(worldRelation).max(12), facts: z.array(z.strictObject({ label: z.string().max(400), value: z.string().max(400) })).max(8) });
const change = z.strictObject({ added: z.array(claim).max(128), removed: z.array(claim).max(128), changed: z.array(z.strictObject({ claim, fields: z.array(z.enum(["perspective", "valid", "context", "assessments", "conflict"])).max(5) })).max(128), truncated: z.boolean() });
export const atlasFragment: McpWorldOp = {
  name: "atlas", fields: { panel: z.enum(panels).optional(), focus: z.strictObject({ operation: z.enum(operations), ref: WORLD_OBJECT_REF, card: z.literal("kizuki.situation-card/v2").optional() }).optional(), baselineView: view.optional() },
  data: { "kizuki.atlas/v1": { panel: z.enum(panels), panels: z.array(z.strictObject({ panel: z.enum(["resume", "changed", "people", "questions", "commitments", "stale", "corrections"]), title: z.string().max(400), status: z.enum(["ready", "empty", "partial", "unavailable"]), reason: z.enum(["not_landed", "baseline_required", "baseline_unusable", "budget", "storage", "history"]).nullable(), entries: z.array(entry).max(4), change: change.nullable(), nextView: view.nullable(), coverage: worldCoverage })).min(1).max(7), coverage: worldCoverage } },
  summary: "atlas: panel; changed/corrections need focus+baselineView; missing providers stay unavailable.",
};
