import { targetProblem } from "@kizuki/core";
import type { PageType, SubjectRef } from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";
import {
  sanitizeLine,
  slug,
  subjectId,
  toFrontmatterValue,
} from "../legacy/coerce";
import type { LegacyWikiMapping } from "./mapping";
import type { LegacyWikiFieldReport } from "./report";

/**
 * One decision per aspect of a page. Each is total: given any frontmatter a
 * wiki can hold, it returns both what the page becomes and what that cost.
 */

export const MAX_EXTENSIONS = 64;
const MAX_SUBJECTS = 200;
const MAX_SEGMENT_LENGTH = 64;
const MAX_METADATA_FRONTMATTER = 64 * 1024;
const EXTENSION_NAME = /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface FieldPlan {
  extensions: Record<string, FrontmatterValue>;
  reports: LegacyWikiFieldReport[];
}

export function stem(relpath: string): string {
  const name = relpath.slice(relpath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A legacy value usable as vocabulary; anything else is reported unusable. */
export function vocabulary(raw: unknown): string | null | "unusable" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "boolean") return String(raw);
  return "unusable";
}

function headingTitle(body: string): string | null {
  const heading = /^#[ \t]+(.+)$/m.exec(body);
  if (heading === null) return null;
  const title = sanitizeLine(heading[1] as string, 200);
  return title.length === 0 ? null : title;
}

export function planTitle(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
  relpath: string,
  body: string,
): { title: string; source: "field" | "heading" | "filename" } {
  const raw = data[mapping.title.field];
  if (typeof raw === "string") {
    const title = sanitizeLine(raw, 200);
    if (title.length > 0) return { title, source: "field" };
  }
  const heading = headingTitle(body);
  if (heading !== null) return { title: heading, source: "heading" };
  const name = sanitizeLine(stem(relpath), 200);
  return { title: name.length === 0 ? "page" : name, source: "filename" };
}

export function planSubjects(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
): SubjectRef[] {
  if (mapping.subjects === null) return [];
  const raw = data[mapping.subjects.field];
  const values =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string")
        : [];
  const subjects: SubjectRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (subjects.length >= MAX_SUBJECTS) break;
    const id = subjectId(mapping.subjects.namespace, value);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    subjects.push({
      subject_id: id,
      role: mapping.subjects.role,
      display_name: sanitizeLine(value, 120),
    });
  }
  return subjects;
}

export function planFields(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
  slots: Map<string, string>,
  reserved: number,
): FieldPlan {
  const extensions: Record<string, FrontmatterValue> = {};
  const reports: LegacyWikiFieldReport[] = [];
  const taken = new Set<string>();
  const budget = MAX_EXTENSIONS - reserved;

  for (const key of Object.keys(data)) {
    const label = sanitizeLine(key, 120);
    const slot = slots.get(key);
    if (slot !== undefined) {
      reports.push({ key: label, outcome: "mapped", to: slot });
      continue;
    }
    const explicit = Object.prototype.hasOwnProperty.call(mapping.fields, key)
      ? mapping.fields[key]
      : undefined;
    if (explicit === null) {
      reports.push({ key: label, outcome: "dropped", note: "by_mapping" });
      continue;
    }
    if (!/[A-Za-z0-9]/.test(key.normalize("NFKC"))) {
      reports.push({ key: label, outcome: "dropped", note: "unnameable" });
      continue;
    }
    const name =
      explicit ?? (EXTENSION_NAME.test(key) ? key : `x-${slug(key)}`);
    if (taken.has(name)) {
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: "name_conflict",
      });
      continue;
    }
    if (taken.size >= budget) {
      // The page-candidate contract caps the extension bag; past the cap the
      // page still imports, and the report says which fields did not.
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: "over_limit",
      });
      continue;
    }
    const coerced = toFrontmatterValue(data[key]);
    if (!coerced.ok) {
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: coerced.reason,
      });
      continue;
    }
    taken.add(name);
    extensions[name] = coerced.value;
    if (coerced.note !== "kept") {
      reports.push({
        key: label,
        outcome: "coerced",
        to: name,
        note: coerced.note,
      });
      continue;
    }
    reports.push({
      key: label,
      outcome: name === key ? "kept" : "renamed",
      to: name,
    });
  }
  return { extensions, reports };
}

/**
 * A distinct leaf for a target another page already took. The suffix goes onto
 * a leaf already trimmed to make room for it: re-slugging `${leaf}-${suffix}`
 * would truncate the suffix straight back off a leaf that is already at the
 * segment limit, and the search for a free name would never end.
 */
function collisionLeaf(leaf: string, suffix: number): string {
  const mark = `-${suffix}`;
  const base = leaf
    .slice(0, MAX_SEGMENT_LENGTH - mark.length)
    .replace(/[-.]+$/, "");
  return `${base}${mark}`;
}

export function planTarget(
  relpath: string,
  type: PageType,
  mapping: LegacyWikiMapping,
  taken: Set<string>,
  notes: string[],
): string {
  const directory = mapping.target.directories[type];
  const leaf = slug(stem(relpath));
  const parents = relpath.slice(0, relpath.lastIndexOf("/") + 1);
  let target = `${directory}/${leaf}`;
  if (mapping.target.mode === "mirror" && parents.length > 0) {
    const mirrored = parents
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => slug(segment));
    const candidate = `${directory}/${mirrored.join("/")}/${leaf}`;
    if (targetProblem(candidate) === null) target = candidate;
    else notes.push("target: flattened");
  }
  if (targetProblem(target) !== null) {
    // Unreachable by construction; a wrong path is a bug, not a page loss.
    target = `${directory}/${leaf}`;
    notes.push("target: flattened");
  }

  const prefix = target.slice(0, target.lastIndexOf("/") + 1);
  let unique = target;
  let suffix = 2;
  // Two suffixes can never produce the same leaf (the suffix is everything
  // after the last "-"), so the loop cannot outlive the set it is avoiding.
  while (taken.has(unique)) {
    unique = `${prefix}${collisionLeaf(leaf, suffix)}`;
    suffix += 1;
  }
  if (unique !== target) notes.push("target_collision");
  taken.add(unique);
  return unique;
}

export function jsonSafeFrontmatter(
  data: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { omitted: "size" } {
  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? "";
  } catch {
    return { omitted: "size" };
  }
  if (serialized.length === 0 || serialized.length > MAX_METADATA_FRONTMATTER) {
    return { omitted: "size" };
  }
  return { frontmatter: JSON.parse(serialized) as Record<string, unknown> };
}
