import { cardCodec, coverage, exact, relationList, wireRef, type Coverage, type Relation, type WorldWireRef } from "./world-card-kit";
import { isPlainObject } from "../util/validate";

export const ATLAS_SCHEMA = "kizuki.atlas/v1" as const;
export const ATLAS_PANELS = ["home", "resume", "changed", "people", "questions", "commitments", "stale", "corrections"] as const;
export type AtlasPanelName = typeof ATLAS_PANELS[number];
export const ATLAS_OBJECT_OPERATIONS = ["concept", "situation", "person", "question", "procedure", "skill", "framework", "artifact_version"] as const;
export type AtlasObjectOperation = typeof ATLAS_OBJECT_OPERATIONS[number];
export interface AtlasEntry {
  readonly ref: WorldWireRef<"object"> | null;
  readonly operation: AtlasObjectOperation | null;
  readonly title: string;
  /** Whole qualified assertions. Evidence expands through the ordinary evidence operation. */
  readonly relations: readonly Relation[];
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}
export interface AtlasChange {
  readonly added: readonly WorldWireRef<"claim">[];
  readonly removed: readonly WorldWireRef<"claim">[];
  readonly changed: readonly { readonly claim: WorldWireRef<"claim">; readonly fields: readonly string[] }[];
  readonly truncated: boolean;
}
export interface AtlasPanel {
  readonly panel: Exclude<AtlasPanelName, "home">;
  readonly title: string;
  readonly status: "ready" | "empty" | "partial" | "unavailable";
  readonly reason: "not_landed" | "baseline_required" | "baseline_unusable" | "budget" | "storage" | "history" | null;
  readonly entries: readonly AtlasEntry[];
  readonly change: AtlasChange | null;
  readonly nextView: { readonly kind: "view"; readonly token: string } | null;
  readonly coverage: Coverage;
}
export type Atlas = { readonly schema: typeof ATLAS_SCHEMA; readonly panel: AtlasPanelName; readonly panels: readonly AtlasPanel[]; readonly coverage: Coverage };
const text = (v: unknown) => typeof v === "string" && v.length <= 400;
const refs = (v: unknown) => Array.isArray(v) && v.length <= 128 && v.every(x => wireRef(x, "claim"));
const entry = (v: unknown) => isPlainObject(v) && exact(v, ["ref", "operation", "title", "relations", "facts"]) &&
  (v.ref === null || wireRef(v.ref, "object")) && (v.operation === null || ATLAS_OBJECT_OPERATIONS.includes(v.operation as AtlasObjectOperation)) && text(v.title) &&
  Array.isArray(v.relations) && v.relations.length <= 12 && relationList(v.relations) && Array.isArray(v.facts) && v.facts.length <= 8 &&
  v.facts.every(x => isPlainObject(x) && exact(x, ["label", "value"]) && text(x.label) && text(x.value));
const change = (v: unknown) => v === null || isPlainObject(v) && exact(v, ["added", "removed", "changed", "truncated"]) && refs(v.added) && refs(v.removed) &&
  typeof v.truncated === "boolean" && Array.isArray(v.changed) && v.changed.length <= 128 && v.changed.every(x => isPlainObject(x) && exact(x, ["claim", "fields"]) && wireRef(x.claim, "claim") &&
    Array.isArray(x.fields) && x.fields.length <= 5 && x.fields.every(f => ["perspective", "valid", "context", "assessments", "conflict"].includes(String(f))));
const panel = (v: unknown) => isPlainObject(v) && exact(v, ["panel", "title", "status", "reason", "entries", "change", "nextView", "coverage"]) &&
  ATLAS_PANELS.includes(v.panel as AtlasPanelName) && v.panel !== "home" && text(v.title) && ["ready", "empty", "partial", "unavailable"].includes(String(v.status)) &&
  (v.reason === null || ["not_landed", "baseline_required", "baseline_unusable", "budget", "storage", "history"].includes(String(v.reason))) &&
  Array.isArray(v.entries) && v.entries.length <= 4 && v.entries.every(entry) && change(v.change) && (v.nextView === null || isPlainObject(v.nextView) && exact(v.nextView, ["kind", "token"]) && v.nextView.kind === "view" && wireRef({ kind: "object", token: v.nextView.token }, "object")) && coverage(v.coverage);
export const validateAtlas = cardCodec<Atlas, "atlas">({ schema: ATLAS_SCHEMA, label: "atlas", fields: {
  panel: v => ATLAS_PANELS.includes(v as AtlasPanelName), panels: v => Array.isArray(v) && v.length >= 1 && v.length <= 7 && v.every(panel), coverage,
} });
