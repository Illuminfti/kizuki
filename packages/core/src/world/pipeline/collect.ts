import type { Database } from "bun:sqlite";
import {
  rawSubjectNamespace,
  rawSubjectRefKey,
  type RawSubjectRef,
} from "../../contracts/claim-v2";
import type { WorldKindSpec } from "../../contracts/world-kinds";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { authorizedSupportSql, validMeaningSql } from "../policy-sql";
import { eligibleWorldClaim, type Eligible } from "./eligible";
import { claimVisibleSql, type ReadFrame } from "./frame";
import type { Cluster } from "./group";

const MAX_RELATIONS = 128;
const DISCOVERY_SCAN = 256;
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
  frame.stats.claimsVerified += 1;
  return eligibleWorldClaim(frame.ctx, claimId, frame.valid, frame.budget);
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
export type Collector = (frame: ReadFrame, cluster: Cluster) => readonly string[];

/** Live claims that name an endpoint of the cluster as subject or as object, classification and labels first. */
const claimsAboutMembers: Collector = (frame, cluster) => {
  const permitted = authorizedSupportSql(frame.ctx),
    time = validMeaningSql(frame.valid);
  const candidates = frame.ctx.db.query<
    { claim_id: string },
    (string | number)[]
  >(`SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    WHERE discriminator='assertion' AND ${claimVisibleSql(frame, "base")} AND ${time.sql} AND
    ((subject_kind=? AND subject_id=? AND coalesce(json_extract(payload,'$.subject.namespace'),'')=?) OR (json_extract(payload,'$.object.ref.kind')=? AND json_extract(payload,'$.object.ref.id')=? AND coalesce(json_extract(payload,'$.object.ref.namespace'),'')=?))
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
    ORDER BY CASE WHEN c.predicate='world.kind' THEN 0 WHEN c.predicate IN (SELECT value FROM json_each(?)) THEN 1 ELSE 2 END,c.claim_id LIMIT ?`);
  const labels = JSON.stringify(
    activeWorldRegistry().kinds.map((kind) => kind.labelPredicate),
  );
  return cluster.members.flatMap((handle) => {
    const anchor = anchorOf(frame.ctx.db, handle);
    if (anchor === null) return [];
    return candidates
      .all(
        ...time.bindings,
        anchor.kind,
        anchor.id,
        rawSubjectNamespace(anchor),
        anchor.kind,
        anchor.id,
        rawSubjectNamespace(anchor),
        ...permitted.bindings,
        labels,
        MAX_RELATIONS + 1,
      )
      .map((row) => row.claim_id);
  });
};

/** Ordered. A workstream adds one line under its marker. */
export const COLLECTORS: readonly Collector[] = [
  claimsAboutMembers,
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
    ...new Set(collectors.flatMap((collect) => collect(frame, cluster))),
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
): MatchScan {
  const { ctx, valid } = frame;
  const found: { handle: string; labels: string[] }[] = [];
  const wanted = foldLabel(label);
  let traversal = false;
  let next = false;
  let budgetSpent = false;
  let scanned = 0;
  let last: string | null = null;
  let position = after ?? "";
  const permitted = authorizedSupportSql(ctx),
    time = validMeaningSql(valid);
  const labelPolicy = authorizedSupportSql(ctx, "ls"),
    labelTime = validMeaningSql(valid, "lc");
  const filtering = wanted.length > 0;
  const scan = ctx.db.query<
    { handle_id: string; labels: string },
    (string | number)[]
  >(`SELECT b.handle_id, ${filtering ? "json_group_array(json_extract(lc.payload,'$.object.value'))" : "'[]'"} AS labels
    FROM semantic_bindings b JOIN claim_v2_semantics c
    ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace JOIN claims base ON base.claim_id=c.claim_id
    ${filtering ? `    LEFT JOIN claim_v2_semantics lc ON lc.subject_kind=b.raw_kind AND lc.subject_id=b.raw_id AND coalesce(json_extract(lc.payload,'$.subject.namespace'),'')=b.raw_namespace
      AND lc.predicate=? AND lc.polarity='positive' AND ${labelTime.sql}
      AND EXISTS(SELECT 1 FROM claims lb WHERE lb.claim_id=lc.claim_id AND ${claimVisibleSql(frame, "lb")})
      AND EXISTS(SELECT 1 FROM claim_v2_support ls WHERE ls.claim_id=lc.claim_id AND ${labelPolicy.sql})` : ""}
    WHERE b.handle_id>? AND c.predicate='world.kind' AND ${claimVisibleSql(frame, "base")} AND c.polarity='positive' AND json_extract(c.payload,'$.object.ref.id')=? AND ${time.sql}
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
    GROUP BY b.handle_id ORDER BY b.handle_id LIMIT ?`);
  scanning: for (;;) {
    const rows = scan.all(
      ...(filtering
        ? [kind.labelPredicate, ...labelTime.bindings, ...labelPolicy.bindings]
        : []),
      position,
      kind.vocabularyId,
      ...time.bindings,
      ...permitted.bindings,
      DISCOVERY_SCAN,
    );
    for (const row of rows) {
      if (scanned === scanBudget) {
        budgetSpent = true;
        break scanning;
      }
      scanned += 1;
      frame.stats.rowsExamined += 1;
      position = row.handle_id;
      if (
        filtering &&
        !(JSON.parse(row.labels) as unknown[]).some((text) =>
          labelMatches(text, wanted),
        )
      )
        continue;
      const raw = bindingOf(ctx.db, row.handle_id);
      if (raw === null) continue;
      const labels: string[] = [];
      let classified = false;
      const candidates = ctx.db
        .query<{ claim_id: string }, (string | number)[]>(
          `SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
      WHERE c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=? AND c.predicate IN ('world.kind',?) AND ${claimVisibleSql(frame, "base")} AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
      ORDER BY CASE c.predicate WHEN 'world.kind' THEN 0 ELSE 1 END,c.claim_id LIMIT ?`,
        )
        .all(
          raw.raw_kind,
          raw.raw_id,
          raw.raw_namespace,
          kind.labelPredicate,
          ...time.bindings,
          ...permitted.bindings,
          MAX_RELATIONS + 1,
        );
      frame.stats.rowsExamined += candidates.length;
      for (const candidate of candidates.slice(0, MAX_RELATIONS)) {
        const item = verifyClaim(frame, candidate.claim_id);
        if (item === null) continue;
        const semantic = item.semantic;
        if (
          semantic.polarity !== "positive" ||
          semantic.perspective.mode !== "asserted"
        )
          continue;
        if (
          semantic.predicate === "world.kind" &&
          semantic.object.kind === "vocabulary" &&
          semantic.object.ref.id === kind.vocabularyId
        )
          classified = true;
        if (
          semantic.predicate === kind.labelPredicate &&
          semantic.object.kind === "literal"
        )
          labels.push(semantic.object.value);
      }
      if (
        !classified ||
        (wanted.length > 0 &&
          !labels.some((text) => labelMatches(text, wanted)))
      )
        continue;
      if (found.length === MAX_WORLD_MATCHES) {
        next = true;
        break scanning;
      }
      found.push({ handle: row.handle_id, labels });
      last = row.handle_id;
      traversal ||= candidates.length > MAX_RELATIONS;
    }
    if (rows.length < DISCOVERY_SCAN) break;
  }
  return {
    found,
    resumeAfter: budgetSpent ? position : next ? last : null,
    cut: traversal || next || budgetSpent,
    visibleHandles: scanned,
  };
}
