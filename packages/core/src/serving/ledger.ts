import { selectedEvent } from "../query/selection";
import type { Database } from "bun:sqlite";
import { liveEventIds } from "../ledger/ledger";
import {
  SOURCE_FIELDS,
  inspectSourceGrant,
  sourceEventsAllowed,
  sourcePolicyEpoch,
  sourceSensitivity,
  type SourceGrant,
  type SourceGrantLookup,
} from "../ledger/source-grants";
import { tableExists } from "../ledger/schema";
import { raiseSensitivity } from "../contracts/event";
import { currentVersionSql, type VersionScope } from "../search/versions";
import type { ServeContext } from "./types";
import { authorize, denyClassesOf } from "../agents";
import { classesByEvent, classesOfEvents } from "../ledger/event-classes";
import type { AuditDenial, DenyReason, Grant, Sensitivity, Servable } from "../agents";
import { PREVIEW_CODE_POINTS, timeline } from "../query/timeline";
import type { TimelineEntry, TimelineOptions } from "../query/timeline";
import { bareRetrievalId, retrievalDocId } from "../retrieval/ids";
import type { SearchHit } from "../search/query";
import { placeholders } from "../util/sql";
import { asSensitivity } from "./canon";
import { redactorOf } from "./redact";
import { boundScrubText } from "../producer/scrub";
import type { QuotedChunk } from "./types";

/** Bound on one `IN (...)` list, matching the graph layer's frontier chunk. */
const ID_CHUNK = 500;

export interface ServableEvent {
  event_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: string;
  subjects: string[];
  /** Content classes stamped on the event; absent until read from the ledger. */
  classes?: readonly string[];
}

export interface QuotedSource extends ServableEvent {
  connector_id: string;
  text: string;
  source_record_id?: string;
  text_hash?: string;
  accepted_at?: string;
  metadata?: string;
}

interface ServableEventRow {
  event_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: string;
  subjects: string;
}

function chunks(ids: string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    result.push(ids.slice(index, index + ID_CHUNK));
  }
  return result;
}

function subjectIds(raw: string): string[] {
  return (JSON.parse(raw) as { subject_id: string }[]).map(
    ({ subject_id }) => subject_id,
  );
}

export { liveEventIds };

/** Metadata only: the captured text stays out of authorization decisions. */
export function readServableEvents(
  db: Database,
  ids: string[],
): Map<string, ServableEvent> {
  const live = liveEventIds(db, [
    ...new Set(ids.map((id) => bareRetrievalId(id))),
  ]);
  const facts = new Map<string, ServableEvent>();
  for (const group of chunks([...live])) {
    const classes = classesByEvent(db, group);
    const rows = db
      .query<ServableEventRow, string[]>(
        `SELECT event_id, kind, occurred_at,
                coalesce(sensitivity_hint, 'unlabeled') AS sensitivity, subjects
           FROM events
          WHERE event_id IN (${placeholders(group.length)})`,
      )
      .all(...group);
    for (const row of rows) {
      const event: ServableEvent = {
        event_id: row.event_id,
        kind: row.kind,
        occurred_at: row.occurred_at,
        sensitivity: row.sensitivity,
        subjects: subjectIds(row.subjects),
        classes: classes.get(row.event_id) ?? [],
      };
      facts.set(row.event_id, event);
      facts.set(retrievalDocId("event", row.event_id), event);
    }
  }
  return facts;
}

/**
 * `type` carries the event kind, so a `types`-scoped grant restricts ledger
 * events by kind the same way it restricts canon pages by page type.
 */
export function eventServable(facts: ServableEvent): Servable {
  return {
    id: facts.event_id,
    sensitivity: facts.sensitivity,
    type: facts.kind,
    subjects: facts.subjects,
    occurred_at: facts.occurred_at,
    ...(facts.classes === undefined ? {} : { classes: facts.classes }),
  };
}

/** Single-call synchronous memoization of validated source grants. */
export function createSourceGrantLookup(db: Database): SourceGrantLookup {
  const grants = new Map<string, SourceGrant | null>();
  return (sourceKey: string): SourceGrant | null => {
    if (grants.has(sourceKey)) return grants.get(sourceKey)!;
    const loaded = inspectSourceGrant(db, sourceKey);
    grants.set(sourceKey, loaded);
    return loaded;
  };
}

/**
 * Owner-only fast-path check: true only when every live event in the ledger is
 * provably authorized under an unconstrained owner grant, so separate owner
 * withheld scans cannot possibly discover any denied event.
 */
export function ownerCannotHaveDeniedEvents(
  ctx: ServeContext,
  grant: Grant,
  grantOf?: SourceGrantLookup,
): boolean {
  if (ctx.principal.kind !== "owner") return false;
  if (
    grant.ceiling !== "private" ||
    grant.types !== null ||
    grant.subjects !== null ||
    grant.since !== null ||
    grant.until !== null ||
    denyClassesOf(grant).length > 0 ||
    ctx.selection !== undefined
  ) {
    return false;
  }
  const db = ctx.db;
  if (
    db.query(
      "SELECT 1 FROM events WHERE deleted = 0 AND (sensitivity_hint IS NULL OR sensitivity_hint NOT IN ('public', 'personal', 'private')) LIMIT 1",
    ).get() !== null
  ) {
    return false;
  }
  if (sourcePolicyEpoch(db) === 0) return true;
  if (!tableExists(db, "source_grants") || !tableExists(db, "source_event_bindings")) {
    return false;
  }
  const purpose = ctx.sourcePurpose ?? "recall";
  const lookup = grantOf ?? createSourceGrantLookup(db);
  const rows = db.query<{ source_key: string }, []>("SELECT source_key FROM source_grants").all();
  for (const row of rows) {
    const loaded = lookup(row.source_key);
    if (
      loaded === null ||
      loaded.status !== "active" ||
      !loaded.policy.purposes.includes(purpose) ||
      !SOURCE_FIELDS.every((field) => loaded.policy.allowed_fields.includes(field))
    ) {
      return false;
    }
  }
  if (
    db.query(
      "SELECT 1 FROM source_event_bindings b WHERE NOT EXISTS (SELECT 1 FROM source_grants g WHERE g.source_key = b.source_key) LIMIT 1",
    ).get() !== null
  ) {
    return false;
  }
  return true;
}

export type EventDecisionResult = ReturnType<typeof eventDecision>;

/**
 * Batched equivalent of calling `eventDecision(grant, facts, ctx, grantOf)` on
 * every item in `events`. Replaces O(N) per-event source-binding and class
 * queries with chunked bulk SQL lookups while preserving exact decision rules.
 */
export function authorizeEventsBatch(
  ctx: ServeContext,
  grant: Grant,
  events: readonly ServableEvent[],
  grantOf?: SourceGrantLookup,
): Map<string, EventDecisionResult> {
  const results = new Map<string, EventDecisionResult>();
  if (events.length === 0) return results;

  const db = ctx.db;
  const lookup = grantOf ?? createSourceGrantLookup(db);
  const deniedClassSet = new Set<string>(denyClassesOf(grant));
  const owner = ctx.principal.kind === "owner";
  const purpose = ctx.sourcePurpose ?? "recall";

  // Pre-filter with in-memory scope check before any SQL lookups.
  const pending: ServableEvent[] = [];
  for (const facts of events) {
    if (results.has(facts.event_id)) continue;
    const scope = authorize(grant, eventServable(facts));
    if (!scope.allow) {
      results.set(facts.event_id, scope);
      continue;
    }
    pending.push(facts);
  }
  if (pending.length === 0) return results;

  const pendingIds = [...new Set(pending.map((event) => event.event_id))];
  const missingClassIds = [...new Set(pending.filter((event) => event.classes === undefined).map((event) => event.event_id))];
  const loadedClasses = missingClassIds.length > 0 ? classesByEvent(db, missingClassIds) : null;

  const epoch = sourcePolicyEpoch(db);
  interface BindingRow {
    event_id: string;
    has_text: number;
    subjects: string;
    attachments: string;
    metadata: string;
    source_key: string | null;
    is_native: number;
  }
  const bindingById = new Map<string, BindingRow>();
  if (epoch !== 0) {
    const hasNative = tableExists(db, "native_owner_evidence");
    const nativeJoin = hasNative
      ? "LEFT JOIN native_owner_evidence n ON n.event_id = e.event_id AND n.origin = 'correction'"
      : "";
    const nativeCol = hasNative ? "CASE WHEN n.event_id IS NOT NULL THEN 1 ELSE 0 END" : "0";
    for (const group of chunks(pendingIds)) {
      const rows = db.query<BindingRow, string[]>(
        `SELECT e.event_id, (length(e.text) > 0) AS has_text, e.subjects, e.attachments, e.metadata,
                b.source_key, ${nativeCol} AS is_native
           FROM events e
           LEFT JOIN source_event_bindings b ON b.event_id = e.event_id
           ${nativeJoin}
          WHERE e.event_id IN (${placeholders(group.length)})`,
      ).all(...group);
      for (const row of rows) bindingById.set(row.event_id, row);
    }
  }

  for (const facts of pending) {
    if (results.has(facts.event_id)) continue;
    const classes = facts.classes ?? loadedClasses?.get(facts.event_id) ?? [];
    if (deniedClassSet.size > 0 && classes.some((name) => deniedClassSet.has(name))) {
      results.set(facts.event_id, { allow: false, reason: "held" });
      continue;
    }
    let sourceGrant: SourceGrant | null = null;
    if (epoch !== 0) {
      const row = bindingById.get(facts.event_id);
      if (row === undefined) {
        results.set(facts.event_id, { allow: false, reason: "held" });
        continue;
      }
      if (row.source_key === null) {
        if (row.is_native === 0 && !owner) {
          results.set(facts.event_id, { allow: false, reason: "held" });
          continue;
        }
      } else {
        sourceGrant = lookup(row.source_key);
        if (
          sourceGrant === null ||
          sourceGrant.status !== "active" ||
          !sourceGrant.policy.purposes.includes(purpose)
        ) {
          results.set(facts.event_id, { allow: false, reason: "held" });
          continue;
        }
        const allowed = sourceGrant.policy.allowed_fields;
        if (
          (row.has_text !== 0 && !allowed.includes("text")) ||
          (!allowed.includes("subjects") && Object.keys(JSON.parse(row.subjects) as object).length > 0) ||
          (!allowed.includes("attachments") && Object.keys(JSON.parse(row.attachments) as object).length > 0) ||
          (!allowed.includes("metadata") && Object.keys(JSON.parse(row.metadata) as object).length > 0)
        ) {
          results.set(facts.event_id, { allow: false, reason: "held" });
          continue;
        }
      }
    }
    if (ctx.selection !== undefined && !selectedEvent(db, ctx.selection, facts.event_id)) {
      results.set(facts.event_id, { allow: false, reason: "held" });
      continue;
    }
    const original = asSensitivity(facts.sensitivity);
    if (original === null) {
      results.set(facts.event_id, { allow: false, reason: "missing_sensitivity" });
      continue;
    }
    const label =
      epoch !== 0 && bindingById.get(facts.event_id)?.source_key !== null
        ? raiseSensitivity(original, sourceGrant?.policy.sensitivity_floor ?? "private")
        : original;
    const known: ServableEvent = facts.classes === undefined ? { ...facts, classes } : facts;
    const decision = authorize(grant, { ...eventServable(known), sensitivity: label });
    results.set(
      facts.event_id,
      decision.allow ? { allow: true, sensitivity: label } : { allow: false, reason: decision.reason },
    );
  }
  return results;
}

/** Batch-check which of `eventIds` are current versions under `scope`. */
export function currentVersionsBatch(
  db: Database,
  eventIds: readonly string[],
  scope: VersionScope,
): Set<string> {
  const result = new Set<string>();
  const unique = [...new Set(eventIds)];
  if (unique.length === 0) return result;
  const current = currentVersionSql(db, scope);
  for (const group of chunks(unique)) {
    const rows = db.query<{ event_id: string }, (string | number)[]>(
      `SELECT event_id FROM events WHERE event_id IN (${placeholders(group.length)}) AND ${current.sql}`,
    ).all(...group, ...current.bindings);
    for (const row of rows) result.add(row.event_id);
  }
  return result;
}

/** Batch-load authoritative current rows for multiple live event IDs. */
export function currentQuotedSourcesBatch(
  db: Database,
  eventIds: readonly string[],
): Map<string, QuotedSource> {
  const unique = [...new Set(eventIds)];
  const out = new Map<string, QuotedSource>();
  if (unique.length === 0) return out;
  const live = liveEventIds(db, unique);
  if (live.size === 0) return out;
  for (const group of chunks([...live])) {
    const rows = db.query<
      ServableEventRow & {
        connector_id: string;
        text: string;
        source_record_id: string;
        text_hash: string;
        accepted_at: string;
        metadata: string;
      },
      string[]
    >(
      `SELECT event_id, connector_id, source_record_id, kind, occurred_at, text,
              coalesce(sensitivity_hint, 'unlabeled') AS sensitivity, subjects,
              text_hash, accepted_at, metadata
         FROM events WHERE event_id IN (${placeholders(group.length)})`,
    ).all(...group);
    for (const row of rows) {
      out.set(row.event_id, { ...row, subjects: subjectIds(row.subjects) });
    }
  }
  return out;
}

export function eventDecision(
  grant: Grant,
  facts: ServableEvent,
  ctx?: ServeContext,
  grantOf?: SourceGrantLookup,
):
  | { allow: true; sensitivity: Sensitivity }
  | { allow: false; reason: DenyReason } {
  const scope = authorize(grant, eventServable(facts));
  if (!scope.allow) return scope;
  if (ctx !== undefined && !sourceEventsAllowed(ctx.db, [facts.event_id], { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant), ...(grantOf === undefined ? {} : { grantOf }) })) return { allow: false, reason: "held" };
  if (ctx !== undefined && !selectedEvent(ctx.db, ctx.selection, facts.event_id)) return { allow: false, reason: "held" };
  const original = asSensitivity(facts.sensitivity);
  const label = original === null || ctx === undefined ? original : sourceSensitivity(ctx.db, [facts.event_id], original, grantOf);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  // Facts read straight from the ledger carry their classes; a timeline row
  // does not, so a caller with a context looks them up rather than skip the check.
  const known: ServableEvent =
    facts.classes === undefined && ctx !== undefined
      ? { ...facts, classes: classesOfEvents(ctx.db, [facts.event_id]) }
      : facts;
  const decision = authorize(grant, { ...eventServable(known), sensitivity: label });
  return decision.allow
    ? { allow: true, sensitivity: label }
    : { allow: false, reason: decision.reason };
}

export function quotedChunk(
  source: QuotedSource,
  sensitivity: Sensitivity,
  ctx: ServeContext,
  maxChars = 4096,
): QuotedChunk {
  const redactor = redactorOf(ctx);
  const bounded = boundScrubText(source.text, maxChars);
  return {
    event_id: source.event_id,
    connector_id: redactor.text(source.connector_id),
    kind: redactor.text(source.kind),
    occurred_at: source.occurred_at,
    sensitivity,
    subjects: source.subjects.map((subject) => redactor.text(subject)),
    text: redactor.text(bounded.text),
    ...(bounded.truncated ? { truncated: true as const } : {}),
    tainted: true,
  };
}

export function timelineSource(entry: TimelineEntry): QuotedSource {
  return {
    event_id: entry.event_id,
    connector_id: entry.connector_id,
    kind: entry.kind,
    occurred_at: entry.occurred_at,
    sensitivity: entry.sensitivity,
    subjects: entry.subjects,
    text: entry.text_preview,
  };
}

/**
 * Each SQL page is the caller-visible cap. Compatible grant and source-policy
 * filters run before LIMIT; extra pages only skip residual denials.
 */
const TIMELINE_AUTH_PAGES = 8;

export function collectAuthorizedTimeline(
  ctx: ServeContext,
  opts: Omit<TimelineOptions, "ceiling">,
  limit: number,
): { quoted: QuotedChunk[]; withheld: AuditDenial[]; seen: Set<string> } {
  const quoted: QuotedChunk[] = [];
  const withheld: AuditDenial[] = [];
  const seen = new Set<string>();
  if (limit === 0) return { quoted, withheld, seen };

  const grant = ctx.principal.grant;
  const grantSubjects =
    opts.subject !== undefined || opts.subjects !== undefined
      ? undefined
      : grant.subjects === null
        ? undefined
        : [...grant.subjects];
  const grantKinds =
    opts.kind !== undefined || opts.kinds !== undefined
      ? undefined
      : grant.types === null
        ? undefined
        : [...grant.types];
  let after: TimelineOptions["after"];

  const grantOf = createSourceGrantLookup(ctx.db);
  const redactor = redactorOf(ctx);

  for (let page = 0; page < TIMELINE_AUTH_PAGES && quoted.length < limit; page += 1) {
    const entries = timeline(ctx.db, {
      ...opts,
      ...(ctx.selection === undefined ? {} : { selection: ctx.selection }),
      ceiling: grant.ceiling,
      limit,
      source: {
        owner: ctx.principal.kind === "owner",
        purpose: ctx.sourcePurpose ?? "recall",
        deny_classes: denyClassesOf(grant),
      },
      ...(grantSubjects === undefined ? {} : { subjects: grantSubjects }),
      ...(grantKinds === undefined ? {} : { kinds: grantKinds }),
      ...(after === undefined ? {} : { after }),
    });
    if (entries.length === 0) break;
    const live = liveEventIds(
      ctx.db,
      entries.map((entry) => entry.event_id),
    );
    const liveSources: { entry: TimelineEntry; source: QuotedSource }[] = [];
    for (const entry of entries) {
      seen.add(entry.event_id);
      if (!live.has(entry.event_id)) continue;
      liveSources.push({ entry, source: timelineSource(entry) });
    }
    const decisions = authorizeEventsBatch(
      ctx,
      grant,
      liveSources.map(({ source }) => source),
      grantOf,
    );
    const allowed: { source: QuotedSource; sensitivity: Sensitivity }[] = [];
    for (const { entry, source } of liveSources) {
      const decision = decisions.get(entry.event_id)!;
      if (!decision.allow) {
        withheld.push({ id: entry.event_id, reason: decision.reason });
        continue;
      }
      allowed.push({ source, sensitivity: decision.sensitivity });
      if (quoted.length + allowed.length >= limit) break;
    }
    if (allowed.length > 0) {
      // The preview is cut from the redacted text, and only after the entry is
      // authorized, so neither a cut secret nor a hidden row's secret shows.
      const texts = new Map<string, string>();
      const allowedIds = allowed.map(({ source }) => source.event_id);
      for (const group of chunks(allowedIds)) {
        for (const row of ctx.db.query<{ event_id: string; text: string }, string[]>(
          `SELECT event_id, text FROM events WHERE event_id IN (${placeholders(group.length)})`,
        ).all(...group)) {
          texts.set(row.event_id, row.text);
        }
      }
      for (const { source, sensitivity } of allowed) {
        const text = texts.get(source.event_id);
        if (text === undefined) continue;
        const chunk = quotedChunk({ ...source, text }, sensitivity, ctx);
        quoted.push({ ...chunk, text: redactor.text(chunk.text, { offset: 0, span: PREVIEW_CODE_POINTS, inline: true }) });
        if (quoted.length >= limit) break;
      }
    }
    const last = entries[entries.length - 1];
    if (last === undefined || entries.length < limit) break;
    after = { occurred_at: last.occurred_at, event_id: last.event_id };
  }
  return { quoted, withheld, seen };
}

export function ledgerHitSource(hit: SearchHit): QuotedSource {
  return {
    event_id: bareRetrievalId(hit.doc_id),
    connector_id: hit.connector_id,
    kind: hit.page_type,
    occurred_at: hit.occurred_at,
    sensitivity: hit.sensitivity,
    subjects: hit.subjects,
    text: hit.snippet,
  };
}

/** Load the current authoritative row; cached retrieval snippets are never evidence. */
export function currentQuotedSource(db: Database, eventId: string): QuotedSource | null {
  if (!liveEventIds(db, [eventId]).has(eventId)) return null;
  const row = db.query<
    ServableEventRow & {
      connector_id: string;
      text: string;
      source_record_id: string;
      text_hash: string;
      accepted_at: string;
      metadata: string;
    },
    [string]
  >(
    `SELECT event_id, connector_id, source_record_id, kind, occurred_at, text,
            coalesce(sensitivity_hint, 'unlabeled') AS sensitivity, subjects,
            text_hash, accepted_at, metadata
       FROM events WHERE event_id = ?`,
  ).get(eventId);
  return row === null ? null : { ...row, subjects: subjectIds(row.subjects) };
}
