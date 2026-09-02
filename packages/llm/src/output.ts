export const ENTITY_TYPES = [
  "person",
  "org",
  "project",
  "place",
  "topic",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface SummaryOutput {
  title: string;
  summary: string;
  confidence: number;
}

export interface EntityCandidate {
  name: string;
  type: EntityType;
  aliases: string[];
  evidence: string;
  confidence: number;
}

export interface EntitiesOutput {
  entities: EntityCandidate[];
}

export interface ClaimAtom {
  statement: string;
  subject_id: string | null;
  confidence: number;
}

export interface ClaimsOutput {
  claims: ClaimAtom[];
}

export type OutputResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_json" | "schema" | "empty" };

export const OUTPUT_LIMITS = {
  title: 120,
  summary: 1200,
  entities: 12,
  name: 80,
  aliases: 5,
  alias: 80,
  evidence: 200,
  claims: 20,
  statement: 300,
} as const;

/** Everything a terminal or a Markdown reader would obey rather than display. */
const LINE_BREAKS = /[\t\n\v\f\r\u2028\u2029]/g;
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
/** Same, minus the tab and newline a block is allowed to keep. */
const BLOCK_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code points, so a cap can never leave half a surrogate pair behind. */
function cap(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  return points.length <= maxCodePoints
    ? text
    : points.slice(0, maxCodePoints).join("");
}

/**
 * A run of brackets collapses to one, so no model output can mint a wikilink
 * and quietly add an edge to the graph the owner never drew.
 */
function deWikilink(text: string): string {
  return text.replace(/\[{2,}/g, "[").replace(/\]{2,}/g, "]");
}

/** For anything that must stay on one line: a title, a name, a quote. */
export function sanitizeLine(text: string, maxCodePoints: number): string {
  const flattened = text
    .normalize("NFC")
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(/\s+/g, " ");
  return cap(deWikilink(flattened).trim(), maxCodePoints);
}

/** For prose that may keep its paragraphs: a summary body. */
export function sanitizeBlock(text: string, maxCodePoints: number): string {
  const flattened = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(BLOCK_CONTROLS, "")
    .replace(/\n{3,}/g, "\n\n");
  return cap(deWikilink(flattened).trim(), maxCodePoints);
}

/**
 * Model answers arrive as prose often enough that one fenced block is worth
 * unwrapping; anything else is the endpoint's problem, not the vault's.
 */
export function parseModelJson(
  content: string,
): Record<string, unknown> | undefined {
  let text = content.trim();
  const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
  if (fence !== null) text = (fence[1] ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isPlainRecord(parsed) ? parsed : undefined;
}

function confidence(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : undefined;
}

function schema<T>(): OutputResult<T> {
  return { ok: false, reason: "schema" };
}

function empty<T>(): OutputResult<T> {
  return { ok: false, reason: "empty" };
}

export function validateSummary(raw: unknown): OutputResult<SummaryOutput> {
  if (!isPlainRecord(raw)) return schema();
  const title = raw["title"];
  const summary = raw["summary"];
  const score = confidence(raw["confidence"]);
  if (typeof title !== "string" || typeof summary !== "string" || score === undefined) {
    return schema();
  }
  const value: SummaryOutput = {
    title: sanitizeLine(title, OUTPUT_LIMITS.title),
    summary: sanitizeBlock(summary, OUTPUT_LIMITS.summary),
    confidence: score,
  };
  if (value.title.length === 0 || value.summary.length === 0) return empty();
  return { ok: true, value };
}

function aliasList(raw: unknown): string[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const aliases: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return undefined;
    const alias = sanitizeLine(entry, OUTPUT_LIMITS.alias);
    if (alias.length > 0) aliases.push(alias);
    if (aliases.length === OUTPUT_LIMITS.aliases) break;
  }
  return aliases;
}

export function validateEntities(raw: unknown): OutputResult<EntitiesOutput> {
  if (!isPlainRecord(raw)) return schema();
  const list = raw["entities"];
  if (!Array.isArray(list)) return schema();

  const entities: EntityCandidate[] = [];
  for (const item of list.slice(0, OUTPUT_LIMITS.entities)) {
    if (!isPlainRecord(item)) return schema();
    const name = item["name"];
    const type = item["type"];
    const evidence = item["evidence"];
    const score = confidence(item["confidence"]);
    if (
      typeof name !== "string" ||
      typeof type !== "string" ||
      typeof evidence !== "string" ||
      score === undefined
    ) {
      return schema();
    }
    const aliases = aliasList(item["aliases"]);
    if (aliases === undefined) return schema();
    if (!(ENTITY_TYPES as readonly string[]).includes(type)) continue;

    const candidate: EntityCandidate = {
      name: sanitizeLine(name, OUTPUT_LIMITS.name),
      type: type as EntityType,
      aliases,
      evidence: sanitizeLine(evidence, OUTPUT_LIMITS.evidence),
      confidence: score,
    };
    if (candidate.name.length === 0 || candidate.evidence.length === 0) continue;
    entities.push(candidate);
  }
  return entities.length === 0 ? empty() : { ok: true, value: { entities } };
}

export function validateClaims(
  raw: unknown,
  allowedSubjectIds: readonly string[],
): OutputResult<ClaimsOutput> {
  if (!isPlainRecord(raw)) return schema();
  const list = raw["claims"];
  if (!Array.isArray(list)) return schema();
  const allowed = new Set(allowedSubjectIds);

  const claims: ClaimAtom[] = [];
  for (const item of list.slice(0, OUTPUT_LIMITS.claims)) {
    if (!isPlainRecord(item)) return schema();
    const statement = item["statement"];
    const subject = item["subject_id"];
    const score = confidence(item["confidence"]);
    if (typeof statement !== "string" || score === undefined) return schema();
    if (subject !== undefined && subject !== null && typeof subject !== "string") {
      return schema();
    }
    const claim: ClaimAtom = {
      statement: sanitizeLine(statement, OUTPUT_LIMITS.statement),
      // A subject the record never carried is an invention, not an attribution.
      subject_id:
        typeof subject === "string" && allowed.has(subject) ? subject : null,
      confidence: score,
    };
    if (claim.statement.length === 0) continue;
    claims.push(claim);
  }
  return claims.length === 0 ? empty() : { ok: true, value: { claims } };
}
