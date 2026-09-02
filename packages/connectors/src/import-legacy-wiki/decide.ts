import { targetProblem } from "@kizuki/core";
import type { PageType, SubjectRef } from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";
import {
  sanitizeLine,
  slug,
  slugName,
  subjectId,
  toFrontmatterValue,
} from "../legacy/coerce";
import { RESERVED_EXTENSIONS } from "./mapping";
import type { LegacyWikiMapping } from "./mapping";
import type { LegacyWikiFieldReport } from "./report";

/**
 * One decision per aspect of a page. Each is total: given any frontmatter a
 * wiki can hold, it returns both what the page becomes and what that cost.
 */

const MAX_EXTENSIONS = 64;
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

/**
 * A legacy value usable as vocabulary. Discriminated rather than a sentinel
 * string: a page whose type really is the word "unusable" is a value the
 * mapping may name, and a sentinel would silently take the default instead.
 */
export type Vocabulary =
  | { ok: true; value: string }
  | { ok: false; reason: "absent" | "unusable" };

export function vocabulary(raw: unknown): Vocabulary {
  if (raw === undefined || raw === null) return { ok: false, reason: "absent" };
  if (typeof raw === "string") return { ok: true, value: raw };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { ok: true, value: String(raw) };
  }
  // A boolean, a list or a nested block is not a vocabulary term: `true` is
  // not a type name, and stringifying it would invent one.
  return { ok: false, reason: "unusable" };
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
): FieldPlan {
  const extensions: Record<string, FrontmatterValue> = {};
  const reports: LegacyWikiFieldReport[] = [];
  // Seeded with the names the planner and the floor stamp: a page whose own
  // frontmatter produces one loses the collision, and the report says so
  // rather than claiming the value was carried over.
  const taken = new Set(RESERVED_EXTENSIONS);

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
      explicit ?? (EXTENSION_NAME.test(key) ? key : `x-${slugName(key)}`);
    if (taken.has(name)) {
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: "name_conflict",
      });
      continue;
    }
    if (taken.size >= MAX_EXTENSIONS) {
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

/** Where a page lands before anything else has claimed that path. */
function deriveTarget(
  relpath: string,
  type: PageType,
  mapping: LegacyWikiMapping,
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
    // `slug` builds usable segments, so only a directory the mapping type
    // asserts past the parser gets here; the planner still checks the whole
    // candidate before emitting it.
    target = `${directory}/${leaf}`;
    notes.push("target: flattened");
  }
  return target;
}

/**
 * The targets a run has already handed out. The next free suffix is
 * remembered per target rather than searched from 2 every time: a wiki whose
 * names all slug to one leaf — every estate written in a non-Latin script
 * does — would otherwise cost a quadratic scan over the 50 000 files the walk
 * advertises.
 */
export interface TargetIndex {
  taken: Set<string>;
  next: Map<string, number>;
}

export function newTargetIndex(pinned: Iterable<string>): TargetIndex {
  return { taken: new Set(pinned), next: new Map() };
}

export function planTarget(
  relpath: string,
  type: PageType,
  mapping: LegacyWikiMapping,
  index: TargetIndex,
  notes: string[],
  /** The target a previous run already emitted this page with, when there is one. */
  pinned: string | undefined,
): string {
  const target = deriveTarget(relpath, type, mapping, notes);
  if (pinned !== undefined) {
    // A page keeps the target it was emitted with, and the record still says
    // what deriving it now would have said. The decision travels inside the
    // event, so a note that depended on which run emitted the page would
    // give two byte-identical copies of it two different content hashes.
    if (pinned !== target) notes.push("target_collision");
    index.taken.add(pinned);
    return pinned;
  }

  const prefix = target.slice(0, target.lastIndexOf("/") + 1);
  const leaf = target.slice(target.lastIndexOf("/") + 1);
  let unique = target;
  let suffix = index.next.get(target) ?? 2;
  // A suffixed leaf can still meet a page literally named that way, so the
  // search continues; two suffixes never produce the same leaf, so it ends.
  while (index.taken.has(unique)) {
    unique = `${prefix}${collisionLeaf(leaf, suffix)}`;
    suffix += 1;
  }
  if (unique !== target) {
    notes.push("target_collision");
    index.next.set(target, suffix);
  }
  index.taken.add(unique);
  return unique;
}

export function jsonSafeFrontmatter(
  data: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { omitted: "size" } {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    // A frontmatter value the parser built cannot be circular, but metadata
    // that cannot be serialised must not take the whole run down with it.
    return { omitted: "size" };
  }
  if (serialized.length > MAX_METADATA_FRONTMATTER) return { omitted: "size" };
  return { frontmatter: JSON.parse(serialized) as Record<string, unknown> };
}
