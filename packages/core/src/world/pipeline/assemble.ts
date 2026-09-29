import type {
  ConceptCoverage,
  ViewGap,
} from "../../contracts/concept-card";
import type { WorldKindSpec } from "../../contracts/world-kinds";
import { sourceCoverage } from "../coverage";
import { validateConceptCard, type ConceptCard } from "../../contracts/concept-card";
import { validateSituationCard, type SituationCard } from "../../contracts/situation-card";
import { sealCard, type AssembledCard, type KindAssembler } from "../kinds/kit";
import { issueWorldRef, type WireRef } from "../references";
import type { CardCollection, MatchScan } from "./collect";
import type { CardBody } from "./enrich";
import type { ReadFrame } from "./frame";
import type { Cluster } from "./group";

/**
 * Whether any way of filling a kind is switched on in this build. Extraction
 * counts only while the extraction model is told about the kind.
 */
export function populationEnabled(kind: WorldKindSpec): boolean {
  return kind.population.some(
    (path) => path !== "extraction" || kind.offeredToProducer,
  );
}

/** Source gaps, then the traversal bound, then whatever the enrichers added; each named once. */
export function coverageOf(
  frame: ReadFrame,
  overflow: boolean,
  extra: readonly ViewGap[] = [],
): ConceptCoverage {
  const gaps = [
    ...new Set<ViewGap>([
      ...sourceCoverage(frame.ctx),
      ...(overflow ? (["traversal_limit"] as const) : []),
      ...extra,
    ]),
  ];
  return {
    status: gaps.length === 0 ? "complete_for_query" : "partial",
    gaps,
    validWindow: frame.valid,
    history: "unavailable",
  };
}

/** Opens the card of `kind` around the requested handle and lets the kind's assembler lay it out. */
export function assembleCard(
  frame: ReadFrame,
  kind: WorldKindSpec,
  assembler: KindAssembler,
  cluster: Cluster,
  collection: CardCollection,
  body: CardBody,
): AssembledCard {
  const { db } = frame.ctx;
  const ref = issueWorldRef(db, frame.ns, "object", cluster.anchor);
  const members = new Set(
    cluster.members.map(
      (handle) => issueWorldRef(db, frame.ns, "object", handle).token,
    ),
  );
  const relations = body.claims.map((claim) => claim.relation);
  const own = relations.filter((item) => members.has(item.subject.token));
  const labels = own
    .filter(
      (item) =>
        item.predicate === kind.labelPredicate &&
        item.perspective.mode === "asserted" &&
        item.polarity === "positive" &&
        item.object.kind === "literal",
    )
    .map((item) => ({
      text: item.object.kind === "literal" ? item.object.value : "",
      claim: item.claim,
    }));
  return assembler.assemble({
    frame,
    node: {
      schema: "kizuki.knowledge-node/v1",
      ref,
      kind: kind.id,
      classificationClaims: collection.classification.map((item) =>
        issueWorldRef(db, frame.ns, "claim", item.claimId),
      ),
      labels,
      resolution: cluster.resolution,
    },
    own,
    relations,
    summary: body.summary,
    coverage: coverageOf(frame, collection.overflow, body.gaps),
  });
}

export interface WorldMatches<Schema extends string = string> {
  readonly schema: Schema;
  readonly matches: readonly {
    ref: WireRef<"object">;
    labels: readonly string[];
  }[];
  readonly cursor: string | null;
  readonly coverage: ConceptCoverage;
}

/**
 * One page of discovery. An empty first page for a kind no build path can
 * fill is partial with the gap `coverage`: nothing is missing from the reader's
 * view, but nothing could ever have been there, and complete would say
 * otherwise.
 */
export function assembleMatches<Schema extends string>(
  frame: ReadFrame,
  schema: Schema,
  kind: WorldKindSpec,
  scan: MatchScan,
  first: boolean,
): WorldMatches<Schema> {
  const { db } = frame.ctx;
  const matches = scan.found.map(({ handle, labels }) => ({
    ref: issueWorldRef(db, frame.ns, "object", handle),
    labels,
  }));
  matches.sort(
    (a, b) =>
      (a.labels[0] ?? "").localeCompare(b.labels[0] ?? "") ||
      a.ref.token.localeCompare(b.ref.token),
  );
  const dark = first && scan.visibleHandles === 0 && !populationEnabled(kind);
  return {
    schema,
    matches,
    cursor:
      scan.resumeAfter === null
        ? null
        : issueWorldRef(db, frame.ns, "object", scan.resumeAfter).token,
    coverage: coverageOf(frame, scan.cut, dark ? ["coverage"] : []),
  };
}

const conceptAssembler: KindAssembler = {
  kind: "concept",
  assemble({ node, own, relations, summary, coverage }) {
    const card: ConceptCard = {
      schema: "kizuki.concept-card/v1",
      concept: { ...node, kind: "concept" },
      summary,
      definitions: own.filter(
        (item) => item.predicate === "concept.definition",
      ),
      relations: own.filter(
        (item) =>
          item.predicate !== "concept.definition" &&
          item.predicate !== "concept.label" &&
          item.predicate !== "world.kind",
      ),
      learning: relations
        .filter(
          (item) =>
            /^learning\.(exposure|explanation|application|demonstration)$/.test(
              item.predicate,
            ) &&
            item.object.kind === "node" &&
            item.object.ref.token === node.ref.token,
        )
        .map((item) => ({
          facet: item.predicate.slice(9) as
            | "exposure"
            | "explanation"
            | "application"
            | "demonstration",
          assertion: item,
          assistance: "unknown",
          assistanceEvidence: [],
        })),
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateConceptCard, "concept");
  },
};

const situationAssembler: KindAssembler = {
  kind: "situation",
  assemble({ node, own, summary, coverage }) {
    const select = (predicate: string) =>
      own.filter((item) => item.predicate === predicate);
    const one = (predicate: string) => {
      const found = select(predicate).filter(
        (item) =>
          item.polarity === "positive" && item.perspective.mode === "asserted",
      );
      return found.length === 1 ? found[0]! : null;
    };
    const uncertainty = own.filter(
      (item) =>
        item.perspective.mode !== "asserted" ||
        item.polarity === "negative" ||
        ([
          "situation.objective",
          "situation.blocker",
          "situation.change",
        ].includes(item.predicate) &&
          select(item.predicate).length > 1),
    );
    const card: SituationCard = {
      schema: "kizuki.situation-card/v1",
      situation: { ...node, kind: "situation" },
      summary,
      objective: one("situation.objective"),
      participants: select("situation.participant")
        .filter(
          (item) =>
            item.polarity === "positive" &&
            item.perspective.mode === "asserted",
        )
        .flatMap((item) =>
          item.object.kind === "node" ? [item.object.ref] : [],
        ),
      commitments: select("situation.commitment"),
      blocker: one("situation.blocker"),
      recentChange: one("situation.change"),
      uncertainty,
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateSituationCard, "situation");
  },
};

/** One assembler per kind that has a card. */
export const ASSEMBLERS: readonly KindAssembler[] = [conceptAssembler, situationAssembler];
