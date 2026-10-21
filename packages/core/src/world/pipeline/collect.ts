import { personStatements } from "../collectors/person";
import { createRedactor } from "../../serving/redact";
import type { Database } from "bun:sqlite";
import {
  rawSubjectNamespace,
  rawSubjectRefKey,
  type RawSubjectRef,
} from "../../contracts/claim-v2";
import type { WorldKindSpec } from "../../contracts/world-kinds";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { authorizedClaimSql } from "../policy-sql";
import { knownSupportSql, knownValidSql, knownHeldSql } from "../known/cutoff";
import { recordWorldDependencies } from "../dependencies";
import { eligibleWorldClaim, type Eligible } from "./eligible";
import { claimVisibleSql, WorldProjectionBudgetError, type ReadFrame } from "./frame";
import { group, type Cluster, type Grouper } from "./group";

const MAX_RELATIONS = 128;
const DISCOVERY_SCAN = 256;
/** The existing discovery wire grammar's label bound per match. */
const MAX_MATCH_LABELS = 256;
/** The page size of label discovery. */
export const MAX_WORLD_MATCHES = 32;
/** Most handles one discovery request examines before it hands back a cursor, so a rare label cannot hold the event loop across a whole vault. */
export const WORLD_DISCOVERY_SCAN_BUDGET = 4096;

/** Unicode-aware, locale-independent fold shared by the query and the stored labels. */
export function foldLabel(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase();
}
function labelMatches(text: unknown, wanted: string): boolean {
  return typeof text === "string" && foldLabel(text).includes(wanted);
}

/** One claim through `eligibleWorldClaim`, counted. Every claim a read serves comes through here. */
export function verifyClaim(frame: ReadFrame, claimId: string): Eligible | null {
  const before = frame.budget.claimVerifications;
  let item: Eligible | null;
  try {
    item = eligibleWorldClaim(frame.ctx, claimId, frame.valid, frame.budget, frame.cutoff.kind === "current" ? {} : { cutoff: frame.cutoff });
  } finally {
    frame.stats.claimsVerified += before === undefined ? 1 : frame.budget.claimVerifications! - before;
  }
  if (item !== null && frame.dependencies !== undefined)
    recordWorldDependencies(frame.dependencies, item);
  return item;
}

type Binding = {
  raw_kind: RawSubjectRef["kind"];
  raw_namespace: string;
  raw_id: string;
};

function bindingOf(db: Database, handle: string): Binding | null {
  return db
    .query<
      Binding,
      [string]
    >("SELECT raw_kind,raw_namespace,raw_id FROM semantic_bindings WHERE handle_id=?")
    .get(handle);
}

/** The raw endpoint a handle was allocated for. */
export function anchorOf(db: Database, handle: string): RawSubjectRef | null {
  const raw = bindingOf(db, handle);
  if (raw === null) return null;
  return raw.raw_namespace === ""
    ? { kind: raw.raw_kind, id: raw.raw_id }
    : {
        kind: "supplied",
        id: raw.raw_id,
        namespace: JSON.parse(raw.raw_namespace),
      };
}

/**
 * Candidate claim ids for a card, best first and bounded. A collector says
 * where to look and proves nothing: every id it returns is verified before it
 * is served.
 */
export type Collector = (frame: ReadFrame, cluster: Cluster, kind: WorldKindSpec) => readonly string[];

/** Live claims about members, with the anchor's classification and labels first. */
const claimsAboutMembers: Collector = (frame, cluster) => {
  const permitted = knownSupportSql(frame.ctx, frame.cutoff.kind === "current" ? undefined : frame.cutoff),
    claim = authorizedClaimSql(frame.ctx),
    time = knownValidSql(frame.valid, frame.cutoff.kind === "current" ? undefined : frame.cutoff);
  const held = knownHeldSql(frame.ctx, "base", frame.cutoff.kind === "current" ? undefined : frame.cutoff);
  const candidates = frame.ctx.db.query<
    Binding & { claim_id: string; predicate: string },
    (string | number)[]
  >(`SELECT c.claim_id,c.predicate,c.subject_kind AS raw_kind,c.subject_id AS raw_id,
    coalesce(json_extract(payload,'$.subject.namespace'),'') AS raw_namespace
    FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    WHERE discriminator='assertion' AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql} AND
    ((subject_kind=? AND subject_id=? AND coalesce(json_extract(payload,'$.subject.namespace'),'')=?) OR (json_extract(payload,'$.object.ref.kind')=? AND json_extract(payload,'$.object.ref.id')=? AND coalesce(json_extract(payload,'$.object.ref.namespace'),'')=?))
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}
    ORDER BY CASE WHEN c.predicate='world.kind' THEN 0 WHEN c.predicate IN (SELECT value FROM json_each(?)) THEN 1 ELSE 2 END,c.claim_id LIMIT ?`);
  const labelPredicates = activeWorldRegistry().kinds.map((kind) => kind.labelPredicate);
  const labels = JSON.stringify(labelPredicates);
  const requested = bindingOf(frame.ctx.db, cluster.anchor);
  const priority = (row: Binding & { predicate: string }): number => {
    const predicate = row.predicate === "world.kind" ? 0 : labelPredicates.includes(row.predicate) ? 1 : 2;
    if (predicate === 2) return 4;
    const own = requested !== null && row.raw_kind === requested.raw_kind &&
      row.raw_id === requested.raw_id && row.raw_namespace === requested.raw_namespace;
    return predicate + (own ? 0 : 2);
  };
  const rows = cluster.members.flatMap((handle) => {
    const anchor = anchorOf(frame.ctx.db, handle);
    if (anchor === null) return [];
    return candidates
      .all(
        ...claim.bindings,
        ...time.bindings,
        anchor.kind,
        anchor.id,
        rawSubjectNamespace(anchor),
        anchor.kind,
        anchor.id,
        rawSubjectNamespace(anchor),
        ...permitted.bindings,
        ...held.bindings,
        labels,
        MAX_RELATIONS + 1,
      );
  });
  // Apply the shared claim limit only after merging member candidates. Member
  // order cannot hide the anchor or change which remaining claims are served.
  rows.sort((a, b) => priority(a) - priority(b) || a.claim_id.localeCompare(b.claim_id));
  return rows.map((row) => row.claim_id);
};

/** Ordered. A workstream adds one line under its marker. */
export const COLLECTORS: readonly Collector[] = [
  claimsAboutMembers,
  personStatements,
  // slot: ident
];

export interface CardCollection {
  readonly items: readonly Eligible[];
  readonly overflow: boolean;
  /** The claims that classify the anchor as the requested kind; never empty. */
  readonly classification: readonly Eligible[];
}

/**
 * The eligible claims about a cluster, or null when its anchor is unknown or
 * no live asserted claim classifies the anchor as `kind`. Classification
 * comes from claims, so an unclassified handle is not a card.
 */
export function collectCard(
  frame: ReadFrame,
  cluster: Cluster,
  kind: WorldKindSpec,
  collectors: readonly Collector[],
): CardCollection | null {
  const anchor = anchorOf(frame.ctx.db, cluster.anchor);
  if (anchor === null) return null;
  const candidates = [
    ...new Set(collectors.flatMap((collect) => collect(frame, cluster, kind))),
  ];
  frame.stats.rowsExamined += candidates.length;
  const items: Eligible[] = [];
  let overflow = false;
  for (const claimId of candidates) {
    const item = verifyClaim(frame, claimId);
    if (item === null) continue;
    if (items.length === MAX_RELATIONS) {
      overflow = true;
      break;
    }
    items.push(item);
    overflow ||= item.overflow;
  }
  const classification = items.filter(
    (item) =>
      rawSubjectRefKey(item.semantic.subject) === rawSubjectRefKey(anchor) &&
      item.semantic.predicate === "world.kind" &&
      item.semantic.polarity === "positive" &&
      item.semantic.object.kind === "vocabulary" &&
      item.semantic.object.ref.id === kind.vocabularyId &&
      item.semantic.perspective.mode === "asserted",
  );
  return classification.length === 0
    ? null
    : { items, overflow, classification };
}

export interface MatchScan {
  /** In scan order, at most one page. */
  readonly found: readonly { handle: string; labels: string[] }[];
  /** The handle the next page resumes after; null when the scan ran to its end. */
  readonly resumeAfter: string | null;
  /** The scan stopped early or a match had more claims than one read carries. */
  readonly cut: boolean;
  /** Classified handles the reader could see and this scan reached, before any label filter. */
  readonly visibleHandles: number;
}

/** A currently authorized relation to a named endpoint, applied before paging. */
export interface MatchFilter {
  readonly predicate: string;
  readonly object: RawSubjectRef;
}

/**
 * Handles of `kind` in id order after `after`, each with its currently
 * authorized label texts. Folding happens here, in one place, because SQL has
 * no Unicode case folding.
 */
export function scanMatches(
  frame: ReadFrame,
  kind: WorldKindSpec,
  label: string,
  after: string | null,
  scanBudget: number,
  groupers: readonly Grouper[] = [],
  filter?: MatchFilter,
  subjects?: readonly string[],
): MatchScan {
  const { ctx, valid } = frame;
  const found: { handle: string; labels: string[] }[] = [];
  const wanted = foldLabel(label);
  const preview = createRedactor(ctx.principal);
  let traversal = false;
  let next = false;
  let budgetSpent = false;
  let scanned = 0;
  let visibleHandles = 0;
  let last: string | null = null;
  let position = after ?? "";
  const permitted = knownSupportSql(ctx, frame.cutoff.kind === "current" ? undefined : frame.cutoff),
    claim = authorizedClaimSql(ctx),
    time = knownValidSql(valid, frame.cutoff.kind === "current" ? undefined : frame.cutoff);
  const held = knownHeldSql(frame.ctx, "base", frame.cutoff.kind === "current" ? undefined : frame.cutoff);
  const related = filter === undefined ? null : {
    sql: `c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id
      AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
      AND c.discriminator='assertion' AND c.predicate=? AND c.polarity='positive'
      AND json_extract(c.payload,'$.perspective.mode')='asserted'
      AND json_extract(c.payload,'$.object.kind')='subject'
      AND json_extract(c.payload,'$.object.ref.kind')=? AND json_extract(c.payload,'$.object.ref.id')=?
      AND coalesce(json_extract(c.payload,'$.object.ref.namespace'),'')=?
      AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}`,
    bindings: [filter.predicate, filter.object.kind, filter.object.id, rawSubjectNamespace(filter.object),
      ...claim.bindings, ...time.bindings, ...permitted.bindings, ...held.bindings],
  };
  const joins = `FROM semantic_bindings b JOIN claim_v2_semantics c
    ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
    JOIN claims base ON base.claim_id=c.claim_id`;
  const classification = `c.discriminator='assertion' AND c.predicate='world.kind'
    AND c.polarity='positive' AND json_extract(c.payload,'$.perspective.mode')='asserted'
    AND json_extract(c.payload,'$.object.kind')='vocabulary' AND json_extract(c.payload,'$.object.ref.id')=?
    AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql}
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}
    ${subjects === undefined ? "" : "AND b.raw_id IN (SELECT value FROM json_each(?))"}
    ${related === null ? "" : `AND EXISTS(SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id) WHERE ${related.sql})`}`;
  const policyBindings = [kind.vocabularyId, ...claim.bindings, ...time.bindings, ...permitted.bindings, ...held.bindings, ...(subjects === undefined ? [] : [JSON.stringify(subjects)]), ...(related?.bindings ?? [])];
  const scan = ctx.db.query<
    { handle_id: string },
    (string | number)[]
  >(`SELECT b.handle_id ${joins} WHERE b.handle_id>? AND ${classification}
    GROUP BY b.handle_id ORDER BY b.handle_id LIMIT ?`);

  const candidates = ctx.db.query<{ claim_id: string }, (string | number)[]>(
    `SELECT c.claim_id ${joins}
      WHERE b.handle_id=? AND c.discriminator='assertion' AND c.predicate IN ('world.kind',?)
      AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}
      ORDER BY CASE c.predicate WHEN 'world.kind' THEN 0 ELSE 1 END,c.claim_id LIMIT ?`,
  );
  const cache = new Map<string, { labels: string[]; overflow: boolean } | null>();
  const matchOf = (handle: string) => {
    if (cache.has(handle)) return cache.get(handle)!;
    const rows = candidates.all(handle, kind.labelPredicate, ...claim.bindings, ...time.bindings, ...permitted.bindings, ...held.bindings, MAX_RELATIONS + 1);
    frame.stats.rowsExamined += rows.length;
    const labels: string[] = [];
    let classified = false;
    for (const row of rows.slice(0, MAX_RELATIONS)) {
      const item = verifyClaim(frame, row.claim_id);
      if (item === null) continue;
      const semantic = item.semantic;
      if (semantic.polarity !== "positive" || semantic.perspective.mode !== "asserted") continue;
      if (semantic.predicate === "world.kind" && semantic.object.kind === "vocabulary" && semantic.object.ref.id === kind.vocabularyId)
        classified = true;
      if (semantic.predicate === kind.labelPredicate && semantic.object.kind === "literal")
        labels.push(semantic.object.value);
    }
    if (classified && related !== null) {
      const links = ctx.db.query<{ claim_id: string }, (string | number)[]>(
        `SELECT c.claim_id FROM semantic_bindings b JOIN claim_v2_semantics c JOIN claims base USING(claim_id)
          WHERE b.handle_id=? AND ${related.sql} ORDER BY c.claim_id LIMIT ?`,
      ).all(handle, ...related.bindings, MAX_RELATIONS + 1);
      frame.stats.rowsExamined += links.length;
      if (links.length > MAX_RELATIONS) throw new WorldProjectionBudgetError();
      classified = links.some(link => verifyClaim(frame, link.claim_id) !== null);
    }
    const match = classified ? { labels, overflow: rows.length > MAX_RELATIONS } : null;
    cache.set(handle, match);
    return match;
  };

  // A grouper may propose handles, never authorize them. Apply the same claim
  // and support policy before limiting members or reading any of their labels.
  const grouped = ctx.db.query<{ handle_id: string }, (string | number)[]>(
    `SELECT b.handle_id ${joins} WHERE b.handle_id IN (SELECT value FROM json_each(?)) AND ${classification}
      GROUP BY b.handle_id ORDER BY b.handle_id LIMIT ?`,
  );
  scanning: for (;;) {
    const rows = scan.all(position, ...policyBindings, DISCOVERY_SCAN);
    for (const row of rows) {
      if (scanned === scanBudget) {
        budgetSpent = true;
        break scanning;
      }
      scanned += 1;
      frame.stats.rowsExamined += 1;
      position = row.handle_id;
      const own = matchOf(row.handle_id);
      if (own === null) continue;
      visibleHandles += 1;
      let labels = own.labels;
      let overflow = own.overflow;
      if (groupers.length > 0) {
        const proposed = group(frame, row.handle_id, groupers);
        overflow ||= proposed.overflow === true;
        const members = grouped.all(JSON.stringify(proposed.members), ...policyBindings, 257);
        frame.stats.rowsExamined += members.length;
        if (members.length > 256) throw new WorldProjectionBudgetError();
        const eligible = members.flatMap((member) => {
          const match = matchOf(member.handle_id);
          return match === null ? [] : [{ handle: member.handle_id, ...match }];
        });
        // The smallest authorized member represents the cluster on every page.
        // Its wire token is still local to the reader's namespace.
        if (eligible[0]?.handle !== row.handle_id) continue;
        if (eligible.reduce((count, member) => count + member.labels.length, 0) > MAX_MATCH_LABELS)
          throw new WorldProjectionBudgetError();
        labels = eligible.flatMap((member) => member.labels);
        overflow ||= eligible.some((member) => member.overflow);
      }
      if (
        wanted.length > 0 && !labels.some((text) => labelMatches(preview.text(text), wanted))
      )
        continue;
      if (found.length === MAX_WORLD_MATCHES) {
        next = true;
        break scanning;
      }
      found.push({ handle: row.handle_id, labels });
      last = row.handle_id;
      traversal ||= overflow;
    }
    if (rows.length < DISCOVERY_SCAN) break;
  }
  return {
    found,
    resumeAfter: budgetSpent ? position : next ? last : null,
    cut: traversal || next || budgetSpent,
    visibleHandles,
  };
}
