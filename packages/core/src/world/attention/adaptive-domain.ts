import type { ConceptCard } from "../../contracts/concept-card";
import type { FrameworkCard } from "../../contracts/framework-card";
import type { PersonCard } from "../../contracts/person-card";
import type { QuestionCard } from "../../contracts/question-card";
import type { SituationCard } from "../../contracts/situation-card";
import type { SkillCard } from "../../contracts/skill-card";
import type { EvidenceRef, Relation, ViewGap, WorldWireRef } from "../../contracts/world-card-kit";
import { packetTokens } from "../../serving/packet-tokenizer";
import { createRedactor } from "../../serving/redact";
import { isOwnerInterestRetraction } from "../correction-support";
import { sourceCoverage } from "../coverage";
import {
  effectiveDependencyWeight,
  mergeWorldDependencies,
  recordDependencyWeight,
  worldDependencies,
  type DependencyWeightClass,
  type EffectiveDependencyWeight,
  type WorldDependencies,
} from "../dependencies";
import type { WorldFrame, WorldValidQuery } from "../ops/types";
import { newReadFrame } from "../pipeline/frame";
import { readWorldCard, readWorldMatches } from "../pipeline/read";
import { resolveWorldObject } from "../references";
import { queryTerms } from "../slice/relevance";
import {
  expansionExpenditure,
  type ExpansionExpenditure,
  type ExpansionLedger,
  type ExpansionStopReason,
} from "./expansion";
import {
  compileDomainTaste,
  normalizeDomainKey,
  type DomainTasteProfile,
  type GroundedTasteItem,
  type TasteRecord,
} from "./taste";

export * from "./taste";
export * from "./expansion";

export const INTEREST_DEFAULT_HALF_LIFE_DAYS = 30;
export const DOMAIN_GRAPH_SCAN_LIMIT = 32;
const DAY_MS = 86_400_000;

export type InterestSignalKind =
  | "explicit_question"
  | "sustained_attention"
  | "selection"
  | "owner_correction"
  | "visit"
  | "generated_summary";

export type InterestStage = "retracted" | "hypothesis" | "developing" | "sustained";

export interface InterestSignal {
  readonly id: string;
  readonly kind: InterestSignalKind;
  readonly domain: string;
  readonly evidenceKey: string;
  readonly observedAt: string | null;
  readonly independence: "independent" | "dependent" | "unknown";
  readonly polarity: "positive" | "negative";
  readonly ownerAssertion?: boolean;
  readonly evidence: readonly EvidenceRef[];
  readonly claim?: WorldWireRef<"claim">;
}

export interface InterestAssessment {
  readonly domain: string;
  readonly stage: InterestStage;
  readonly salience: number;
  readonly rawSignalCount: number;
  readonly independentCount: number;
  readonly dependentCount: number;
  readonly summaryReplayCount: number;
  readonly supersededByOwner: boolean;
  readonly establishesCompetence: false;
  readonly latestEvidenceAt: string | null;
  readonly oldestEvidenceAt: string | null;
  readonly stale: boolean;
  readonly evidence: readonly EvidenceRef[];
}

const SIGNAL_BASE_WEIGHT: Readonly<Record<InterestSignalKind, number>> = Object.freeze({
  owner_correction: 1.0,
  explicit_question: 0.85,
  sustained_attention: 0.75,
  selection: 0.7,
  visit: 0.5,
  generated_summary: 0.0,
});

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function relationEvidence(relation: Relation): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const ref of [...relation.perspective.evidence, ...relation.assessments.flatMap(a => a.evidence)]) {
    seen.set(JSON.stringify(ref), ref);
  }
  return [...seen.values()];
}

function relationObservedAt(relation: Relation): string | null {
  return relation.valid.kind === "known" ? relation.valid.from : null;
}

function relationWeightClass(relation: Relation): DependencyWeightClass {
  if (relation.assessments.some(a => a.epistemicKind === "owner_assertion")) return "owner_assertion";
  if (relation.assessments.some(a => a.independence === "independent")) return "independent_evidence";
  return "dependent_copy";
}

function recordRelationWeights(deps: WorldDependencies, relation: Relation, overrideClass?: DependencyWeightClass): void {
  const weightClass = overrideClass ?? relationWeightClass(relation);
  const observedAt = relationObservedAt(relation);
  for (const ref of relationEvidence(relation)) {
    recordDependencyWeight(deps, {
      key: `event:${ref.eventVersion.token}`,
      kind: "event",
      weightClass,
      observedAt,
    });
  }
  recordDependencyWeight(deps, {
    key: `claim:${relation.claim.token}`,
    kind: "claim",
    weightClass,
    observedAt,
  });
}

/**
 * Deterministic interest decay and salience scoring (A1 & A7).
 * - An isolated visit stays a hypothesis and never establishes competence.
 * - Dependent copies and generated summary replays add zero independent depth.
 * - An owner retraction supersedes the interest interpretation cleanly.
 */
export function computeInterestSalience(
  signals: readonly InterestSignal[],
  nowIso: string = new Date().toISOString(),
  options: { readonly halfLifeDays?: number; readonly staleAfterDays?: number; readonly domain?: string } = {},
): InterestAssessment {
  const domain = options.domain ?? signals[0]?.domain ?? "";
  const halfLifeDays = options.halfLifeDays !== undefined && Number.isFinite(options.halfLifeDays) && options.halfLifeDays > 0
    ? options.halfLifeDays
    : INTEREST_DEFAULT_HALF_LIFE_DAYS;
  const staleAfterDays = options.staleAfterDays !== undefined && Number.isFinite(options.staleAfterDays) && options.staleAfterDays > 0
    ? options.staleAfterDays
    : halfLifeDays * 2;
  const nowMs = Date.parse(nowIso);

  const ownerRetracted = signals.some(signal => signal.ownerAssertion === true && signal.polarity === "negative");
  const allEvidence = new Map<string, EvidenceRef>();
  const independentRoots = new Map<string, { weight: number; observedAt: string | null }>();
  let dependentCount = 0;
  let summaryReplayCount = 0;
  let latestMs = Number.NEGATIVE_INFINITY;
  let oldestMs = Number.POSITIVE_INFINITY;
  let latestEvidenceAt: string | null = null;
  let oldestEvidenceAt: string | null = null;

  for (const signal of signals) {
    for (const ref of signal.evidence) allEvidence.set(JSON.stringify(ref), ref);
    if (signal.observedAt !== null) {
      const parsed = Date.parse(signal.observedAt);
      if (Number.isFinite(parsed)) {
        if (parsed > latestMs) { latestMs = parsed; latestEvidenceAt = signal.observedAt; }
        if (parsed < oldestMs) { oldestMs = parsed; oldestEvidenceAt = signal.observedAt; }
      }
    }
    if (signal.kind === "generated_summary") {
      summaryReplayCount += 1;
      continue;
    }
    if (signal.polarity === "negative") continue;
    if (signal.independence !== "independent" && signal.ownerAssertion !== true) {
      dependentCount += 1;
      continue;
    }
    const base = SIGNAL_BASE_WEIGHT[signal.kind];
    let decay = 1;
    if (Number.isFinite(nowMs) && signal.observedAt !== null) {
      const parsed = Date.parse(signal.observedAt);
      if (Number.isFinite(parsed)) {
        const ageDays = Math.max(0, (nowMs - parsed) / DAY_MS);
        decay = Math.pow(0.5, ageDays / halfLifeDays);
      }
    }
    const decayed = base * decay;
    const prior = independentRoots.get(signal.evidenceKey);
    if (prior === undefined || decayed > prior.weight) {
      independentRoots.set(signal.evidenceKey, { weight: decayed, observedAt: signal.observedAt });
    }
  }

  const independentCount = independentRoots.size;
  const rawSalience = [...independentRoots.values()].reduce((sum, entry) => sum + entry.weight, 0);
  const salience = ownerRetracted ? 0 : roundScore(rawSalience);
  const stale = Number.isFinite(nowMs) && Number.isFinite(latestMs)
    ? (nowMs - latestMs) / DAY_MS >= staleAfterDays
    : false;

  const stage: InterestStage = ownerRetracted
    ? "retracted"
    : independentCount >= 3 && salience >= 1.5
      ? "sustained"
      : independentCount >= 2 && salience >= 0.75
        ? "developing"
        : "hypothesis";

  return {
    domain,
    stage,
    salience,
    rawSignalCount: signals.length,
    independentCount: ownerRetracted ? 0 : independentCount,
    dependentCount,
    summaryReplayCount,
    supersededByOwner: ownerRetracted,
    establishesCompetence: false,
    latestEvidenceAt,
    oldestEvidenceAt,
    stale,
    evidence: [...allEvidence.values()],
  };
}

export type FacetState<T> =
  | { readonly status: "evidenced"; readonly items: readonly T[] }
  | { readonly status: "unknown"; readonly items: readonly []; readonly reason: "no_permitted_evidence" };

function facetOf<T>(items: readonly T[]): FacetState<T> {
  return items.length > 0
    ? { status: "evidenced", items }
    : { status: "unknown", items: [], reason: "no_permitted_evidence" };
}

export interface DomainFacetNode {
  readonly ref: WorldWireRef<"object">;
  readonly kind: string;
  readonly label: string;
  readonly relation: string;
  readonly claim: WorldWireRef<"claim">;
  readonly evidence: readonly EvidenceRef[];
  readonly uncertainty: "asserted" | "uncertain" | "conflicted";
}

export interface DomainTimelineEntry {
  readonly at: string | "unknown";
  readonly kind: string;
  readonly predicate: string;
  readonly claim: WorldWireRef<"claim">;
  readonly evidence: readonly EvidenceRef[];
}

export interface CrossDomainLinkCandidate {
  readonly sourceRef: WorldWireRef<"object">;
  readonly targetRef: WorldWireRef<"object">;
  readonly targetKind: "person" | "situation" | "framework" | "concept" | "skill";
  readonly targetLabel: string;
  readonly predicate: string;
  readonly basis: "claim" | "similarity";
  readonly claim?: WorldWireRef<"claim">;
  readonly evidence: readonly EvidenceRef[];
}

export interface CrossDomainLink {
  readonly sourceRef: WorldWireRef<"object">;
  readonly targetRef: WorldWireRef<"object">;
  readonly targetKind: "person" | "situation" | "framework" | "concept" | "skill";
  readonly targetLabel: string;
  readonly predicate: string;
  readonly claim: WorldWireRef<"claim">;
  readonly evidence: readonly EvidenceRef[];
  readonly reversible: true;
}

/**
 * Cross-domain link guard (A5).
 * Similarity alone never creates an identity merge or an observed relationship;
 * only claim-backed, evidence-bearing, reversible links are admitted.
 */
export function buildCrossDomainLink(candidate: CrossDomainLinkCandidate): CrossDomainLink | null {
  if (candidate.basis !== "claim") return null;
  if (candidate.claim === undefined || candidate.evidence.length === 0) return null;
  return {
    sourceRef: candidate.sourceRef,
    targetRef: candidate.targetRef,
    targetKind: candidate.targetKind,
    targetLabel: candidate.targetLabel,
    predicate: candidate.predicate,
    claim: candidate.claim,
    evidence: candidate.evidence,
    reversible: true,
  };
}

export interface DomainGraph {
  readonly domainRef: WorldWireRef<"object">;
  readonly domainLabel: string;
  readonly concepts: FacetState<DomainFacetNode>;
  readonly experts: FacetState<DomainFacetNode>;
  readonly examples: FacetState<DomainFacetNode>;
  readonly frameworks: FacetState<DomainFacetNode>;
  readonly openQuestions: FacetState<DomainFacetNode>;
  readonly timeline: FacetState<DomainTimelineEntry>;
  readonly taste: DomainTasteProfile;
  readonly crossDomainLinks: readonly CrossDomainLink[];
  readonly interest: InterestAssessment;
  readonly dependencies: WorldDependencies;
  readonly dependencyWeight: EffectiveDependencyWeight;
  readonly coverage: {
    readonly status: "complete_for_query" | "partial";
    readonly gaps: readonly ViewGap[];
  };
}

function relationUncertainty(relation: Relation): "asserted" | "uncertain" | "conflicted" {
  if (relation.conflict === "present") return "conflicted";
  if (relation.perspective.mode !== "asserted" || relation.perspective.interpretation !== "explicit") return "uncertain";
  return "asserted";
}

function objectMatchesToken(relation: Relation, targetToken: string): boolean {
  return relation.object.kind === "node" && relation.object.ref.token === targetToken;
}

function firstLabel(labels: readonly { readonly text: string }[], fallback: string): string {
  return labels[0]?.text ?? fallback;
}

/**
 * Assemble an authorized, evidence-traced Domain Graph for one Concept (A1, A2, A4, A5).
 * Every facet is read through the caller's ReadFrame, unknown facets stay explicit,
 * hidden records change neither bytes nor charged work, and interest is never conflated with competence.
 */
export function readDomainGraph(
  frame: WorldFrame,
  domainRef: WorldWireRef<"object">,
  valid: WorldValidQuery,
  options: {
    readonly now?: string;
    readonly halfLifeDays?: number;
    readonly tasteRecords?: readonly TasteRecord[];
    readonly tasteContext?: readonly string[];
    readonly extraSignals?: readonly InterestSignal[];
    readonly scanLimit?: number;
  } = {},
): DomainGraph | null {
  const now = options.now ?? new Date().toISOString();
  const scanLimit = Math.max(1, Math.min(DOMAIN_GRAPH_SCAN_LIMIT, options.scanLimit ?? DOMAIN_GRAPH_SCAN_LIMIT));
  const deps = worldDependencies();
  const gaps = new Set<ViewGap>(sourceCoverage(frame.ctx, deps));
  const read = newReadFrame(frame.ctx, frame.ns, valid, deps);
  const handle = resolveWorldObject(frame.ctx.db, frame.ns, domainRef.token);
  if (handle === null) return null;

  const conceptCard = readWorldCard(read, handle, "concept") as ConceptCard | null;
  if (conceptCard === null) return null;
  for (const gap of conceptCard.coverage.gaps) gaps.add(gap);

  const domainToken = conceptCard.concept.ref.token;
  const domainLabel = firstLabel(conceptCard.concept.labels, domainToken);

  const concepts: DomainFacetNode[] = [];
  const experts: DomainFacetNode[] = [];
  const examples: DomainFacetNode[] = [];
  const frameworks: DomainFacetNode[] = [];
  const openQuestions: DomainFacetNode[] = [];
  const timeline: DomainTimelineEntry[] = [];
  const crossDomainLinks: CrossDomainLink[] = [];
  const signals: InterestSignal[] = [...(options.extraSignals ?? [])];

  const pushTimeline = (kind: string, relation: Relation) => {
    const ev = relationEvidence(relation);
    if (ev.length === 0) return;
    timeline.push({
      at: relation.valid.kind === "known" ? relation.valid.from : "unknown",
      kind,
      predicate: relation.predicate,
      claim: relation.claim,
      evidence: ev,
    });
  };

  // Concept definitions, related concepts, and examples from the authorized Concept card.
  for (const def of conceptCard.definitions) {
    const ev = relationEvidence(def);
    if (ev.length === 0) continue;
    recordRelationWeights(deps, def);
    concepts.push({
      ref: conceptCard.concept.ref,
      kind: "concept",
      label: def.object.kind === "literal" ? def.object.value : domainLabel,
      relation: def.predicate,
      claim: def.claim,
      evidence: ev,
      uncertainty: relationUncertainty(def),
    });
    pushTimeline("concept", def);
  }

  for (const rel of conceptCard.relations) {
    const ev = relationEvidence(rel);
    if (ev.length === 0) continue;
    recordRelationWeights(deps, rel);
    pushTimeline("concept", rel);
    if (rel.predicate === "concept.example" || rel.predicate === "concept.counterexample") {
      examples.push({
        ref: rel.object.kind === "node" ? rel.object.ref : conceptCard.concept.ref,
        kind: "example",
        label: rel.object.kind === "literal" ? rel.object.value : rel.predicate,
        relation: rel.predicate,
        claim: rel.claim,
        evidence: ev,
        uncertainty: relationUncertainty(rel),
      });
      continue;
    }
    if (rel.object.kind === "node") {
      const targetHandle = resolveWorldObject(frame.ctx.db, frame.ns, rel.object.ref.token);
      const targetCard = targetHandle === null ? null : readWorldCard(read, targetHandle, "concept") as ConceptCard | null;
      if (targetCard === null) continue;
      const targetLabel = firstLabel(targetCard.concept.labels, rel.object.ref.token);
      concepts.push({
        ref: rel.object.ref,
        kind: "concept",
        label: targetLabel,
        relation: rel.predicate,
        claim: rel.claim,
        evidence: ev,
        uncertainty: relationUncertainty(rel),
      });
      const link = buildCrossDomainLink({
        sourceRef: conceptCard.concept.ref,
        targetRef: rel.object.ref,
        targetKind: "concept",
        targetLabel,
        predicate: rel.predicate,
        basis: "claim",
        claim: rel.claim,
        evidence: ev,
      });
      if (link !== null) {
        recordRelationWeights(deps, rel, "cross_domain_link");
        crossDomainLinks.push(link);
      }
    }
  }

  // Frameworks linked to this domain Concept.
  const frameworkMatches = readWorldMatches(read, "framework", "", null, scanLimit);
  if (frameworkMatches.cursor !== null) gaps.add("traversal_limit");
  for (const match of frameworkMatches.matches) {
    const fwHandle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    const fwCard = fwHandle === null ? null : readWorldCard(read, fwHandle, "framework") as FrameworkCard | null;
    if (fwCard === null) continue;
    const links = [...fwCard.components, ...fwCard.applicability].filter(rel => objectMatchesToken(rel, domainToken));
    if (links.length === 0) continue;
    const fwLabel = firstLabel(fwCard.framework.labels, match.ref.token);
    for (const rel of links) {
      const ev = relationEvidence(rel);
      if (ev.length === 0) continue;
      recordRelationWeights(deps, rel);
      frameworks.push({
        ref: fwCard.framework.ref,
        kind: "framework",
        label: fwLabel,
        relation: rel.predicate,
        claim: rel.claim,
        evidence: ev,
        uncertainty: relationUncertainty(rel),
      });
      pushTimeline("framework", rel);
      const link = buildCrossDomainLink({
        sourceRef: conceptCard.concept.ref,
        targetRef: fwCard.framework.ref,
        targetKind: "framework",
        targetLabel: fwLabel,
        predicate: rel.predicate,
        basis: "claim",
        claim: rel.claim,
        evidence: ev,
      });
      if (link !== null) {
        recordRelationWeights(deps, rel, "cross_domain_link");
        crossDomainLinks.push(link);
      }
    }
  }

  // Open questions about this domain Concept (also contribute explicit_question signals to A1).
  const questionMatches = readWorldMatches(read, "question", "", null, scanLimit);
  if (questionMatches.cursor !== null) gaps.add("traversal_limit");
  for (const match of questionMatches.matches) {
    const qHandle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    const qCard = qHandle === null ? null : readWorldCard(read, qHandle, "question") as QuestionCard | null;
    if (qCard === null) continue;
    const links = [...qCard.about, ...qCard.motivations].filter(rel => objectMatchesToken(rel, domainToken));
    if (links.length === 0) continue;
    const qLabel = firstLabel(qCard.question.labels, match.ref.token);
    const isOpen = ["open", "partial", "reopened"].includes(qCard.lifecycle.status);
    for (const rel of links) {
      const ev = relationEvidence(rel);
      if (ev.length === 0) continue;
      recordRelationWeights(deps, rel);
      pushTimeline("question", rel);
      if (isOpen) {
        openQuestions.push({
          ref: qCard.question.ref,
          kind: "question",
          label: qLabel,
          relation: rel.predicate,
          claim: rel.claim,
          evidence: ev,
          uncertainty: relationUncertainty(rel),
        });
      }
      for (const assessment of rel.assessments) {
        for (const evRef of assessment.evidence) {
          signals.push({
            id: `question:${rel.claim.token}:${evRef.eventVersion.token}`,
            kind: "explicit_question",
            domain: domainLabel,
            evidenceKey: evRef.eventVersion.token,
            observedAt: relationObservedAt(rel),
            independence: assessment.independence,
            polarity: rel.polarity,
            ownerAssertion: assessment.epistemicKind === "owner_assertion",
            evidence: [evRef],
            claim: rel.claim,
          });
        }
      }
    }
  }

  // People: strictly separate interest signals (A1) from domain competence/experts (A2) and cross-domain links (A5).
  const personMatches = readWorldMatches(read, "person", "", null, scanLimit);
  if (personMatches.cursor !== null) gaps.add("traversal_limit");
  for (const match of personMatches.matches) {
    const pHandle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    const pCard = pHandle === null ? null : readWorldCard(read, pHandle, "person") as PersonCard | null;
    if (pCard === null) continue;
    const pLabel = firstLabel(pCard.person.labels, match.ref.token);
    for (const group of pCard.perspectives) {
      for (const rel of group.relations) {
        if (!objectMatchesToken(rel, domainToken)) continue;
        const ev = relationEvidence(rel);
        if (ev.length === 0) continue;
        recordRelationWeights(deps, rel);
        pushTimeline("person", rel);
        if (rel.predicate === "person.interest") {
          const retracted = isOwnerInterestRetraction(rel);
          for (const assessment of rel.assessments) {
            const evList = assessment.evidence.length > 0 ? assessment.evidence : ev;
            for (const evRef of evList) {
              signals.push({
                id: `interest:${rel.claim.token}:${evRef.eventVersion.token}`,
                kind: retracted ? "owner_correction" : "visit",
                domain: domainLabel,
                evidenceKey: evRef.eventVersion.token,
                observedAt: relationObservedAt(rel),
                independence: assessment.independence,
                polarity: rel.polarity,
                ownerAssertion: assessment.epistemicKind === "owner_assertion",
                evidence: [evRef],
                claim: rel.claim,
              });
            }
          }
        } else {
          // Non-interest claim linking a person to the domain (e.g. relationship/competence).
          const link = buildCrossDomainLink({
            sourceRef: conceptCard.concept.ref,
            targetRef: pCard.person.ref,
            targetKind: "person",
            targetLabel: pLabel,
            predicate: rel.predicate,
            basis: "claim",
            claim: rel.claim,
            evidence: ev,
          });
          if (link !== null) {
            recordRelationWeights(deps, rel, "cross_domain_link");
            crossDomainLinks.push(link);
          }
        }
      }
    }
    // Check explicit person.role mentioning the domain label only if backed by a linked skill/claim;
    // never elevate person.interest into experts.
  }

  // Skills linked to this domain Concept supply evidence-backed expertise facets (never from interest).
  const skillMatches = readWorldMatches(read, "skill", "", null, scanLimit);
  if (skillMatches.cursor !== null) gaps.add("traversal_limit");
  for (const match of skillMatches.matches) {
    const sHandle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    const sCard = sHandle === null ? null : readWorldCard(read, sHandle, "skill") as SkillCard | null;
    if (sCard === null) continue;
    const links = sCard.about.filter(rel => objectMatchesToken(rel, domainToken));
    if (links.length === 0) continue;
    const sLabel = firstLabel(sCard.skill.labels, match.ref.token);
    const hasPracticeEvidence = sCard.application.length > 0 || sCard.observedOutcome.length > 0 || sCard.demonstrations.length > 0;
    for (const rel of links) {
      const ev = relationEvidence(rel);
      if (ev.length === 0) continue;
      recordRelationWeights(deps, rel);
      if (hasPracticeEvidence) {
        experts.push({
          ref: sCard.skill.ref,
          kind: "skill",
          label: sLabel,
          relation: rel.predicate,
          claim: rel.claim,
          evidence: ev,
          uncertainty: relationUncertainty(rel),
        });
      }
      const link = buildCrossDomainLink({
        sourceRef: conceptCard.concept.ref,
        targetRef: sCard.skill.ref,
        targetKind: "skill",
        targetLabel: sLabel,
        predicate: rel.predicate,
        basis: "claim",
        claim: rel.claim,
        evidence: ev,
      });
      if (link !== null) {
        recordRelationWeights(deps, rel, "cross_domain_link");
        crossDomainLinks.push(link);
      }
    }
  }

  // Situations/projects linked to this domain Concept via context or explicit relations (A5).
  const situationMatches = readWorldMatches(read, "situation", "", null, scanLimit);
  if (situationMatches.cursor !== null) gaps.add("traversal_limit");
  for (const match of situationMatches.matches) {
    const sitHandle = resolveWorldObject(frame.ctx.db, frame.ns, match.ref.token);
    const sitCard = sitHandle === null ? null : readWorldCard(read, sitHandle, "situation") as SituationCard | null;
    if (sitCard === null) continue;
    const sitLabel = firstLabel(sitCard.situation.labels, match.ref.token);
    const candidates: Relation[] = [
      ...(sitCard.objective === null ? [] : [sitCard.objective]),
      ...(sitCard.blocker === null ? [] : [sitCard.blocker]),
      ...(sitCard.recentChange === null ? [] : [sitCard.recentChange]),
      ...sitCard.commitments,
      ...sitCard.uncertainty,
    ].filter(rel => objectMatchesToken(rel, domainToken) || rel.context.some(ctxRef => ctxRef.token === domainToken));
    for (const rel of candidates) {
      const ev = relationEvidence(rel);
      if (ev.length === 0) continue;
      const link = buildCrossDomainLink({
        sourceRef: conceptCard.concept.ref,
        targetRef: sitCard.situation.ref,
        targetKind: "situation",
        targetLabel: sitLabel,
        predicate: rel.predicate,
        basis: "claim",
        claim: rel.claim,
        evidence: ev,
      });
      if (link !== null) {
        recordRelationWeights(deps, rel, "cross_domain_link");
        crossDomainLinks.push(link);
      }
    }
  }

  // Record generated-summary replay weights as strictly 0 if summaries were present.
  if (conceptCard.summary !== null) {
    recordDependencyWeight(deps, {
      key: `summary:${domainToken}`,
      kind: "consolidation",
      weightClass: "generated_summary",
      observedAt: null,
    });
  }

  const allowedSources = new Set(deps.coverage?.sources ?? []);
  const taste = compileDomainTaste(options.tasteRecords ?? [], domainLabel, {
    ...(options.tasteContext === undefined ? {} : { context: options.tasteContext }),
    allowedSources,
  });
  for (const item of [...taste.accepted, ...taste.rejected]) {
    examples.push({
      ref: item.exampleRef ?? conceptCard.concept.ref,
      kind: `taste_${item.stance}`,
      label: item.exampleLabel,
      relation: `taste.${item.stance}`,
      claim: item.claimRef ?? conceptCard.concept.classificationClaims[0]!,
      evidence: item.provenance,
      uncertainty: item.uncertainty === "conflicted" ? "conflicted" : item.uncertainty === "low" ? "asserted" : "uncertain",
    });
  }

  timeline.sort((a, b) => {
    if (a.at === "unknown" && b.at === "unknown") return a.claim.token.localeCompare(b.claim.token);
    if (a.at === "unknown") return 1;
    if (b.at === "unknown") return -1;
    return a.at.localeCompare(b.at) || a.claim.token.localeCompare(b.claim.token);
  });

  const interest = computeInterestSalience(signals, now, {
    ...(options.halfLifeDays === undefined ? {} : { halfLifeDays: options.halfLifeDays }),
    domain: domainLabel,
  });

  if (frame.dependencies !== undefined) mergeWorldDependencies(frame.dependencies, deps);
  const dependencyWeight = effectiveDependencyWeight(deps, {
    now,
    halfLifeDays: options.halfLifeDays ?? INTEREST_DEFAULT_HALF_LIFE_DAYS,
  });

  return {
    domainRef: conceptCard.concept.ref,
    domainLabel,
    concepts: facetOf(concepts),
    experts: facetOf(experts),
    examples: facetOf(examples),
    frameworks: facetOf(frameworks),
    openQuestions: facetOf(openQuestions),
    timeline: facetOf(timeline),
    taste,
    crossDomainLinks,
    interest,
    dependencies: deps,
    dependencyWeight,
    coverage: {
      status: gaps.size === 0 ? "complete_for_query" : "partial",
      gaps: [...gaps],
    },
  };
}

export interface DomainDepthReport {
  readonly domain: string;
  readonly evidencedCoverage: {
    readonly rawRecordCount: number;
    readonly independentEvidenceCount: number;
    readonly dependentCopyCount: number;
    readonly generatedSummaryReplayCount: number;
    readonly independentWeight: number;
    readonly evidencedFacets: readonly string[];
    readonly unknownFacets: readonly string[];
  };
  readonly freshness: {
    readonly latestEvidenceAt: string | null;
    readonly oldestEvidenceAt: string | null;
    readonly status: "fresh" | "aging" | "stale" | "unknown";
  };
  readonly unansweredQuestions: {
    readonly count: number;
    readonly refs: readonly WorldWireRef<"object">[];
  };
  readonly expenditure: ExpansionExpenditure;
  readonly stopping: {
    readonly stopped: boolean;
    readonly reason: ExpansionStopReason | null;
    readonly canInspect: true;
    readonly canCorrect: true;
    readonly canUndo: true;
  };
}

/**
 * Expose evidenced coverage, freshness, unanswered questions, expenditure and
 * stopping state (A7) rather than equating raw record count with understanding.
 * Replaying generated summaries never increases independent evidence depth.
 */
export function assessDomainDepth(
  graph: DomainGraph,
  ledger: ExpansionLedger,
  nowIso: string = new Date().toISOString(),
  options: { readonly freshWithinDays?: number; readonly staleAfterDays?: number } = {},
): DomainDepthReport {
  const domain = graph.domainLabel;
  const freshWithinDays = options.freshWithinDays ?? 14;
  const staleAfterDays = options.staleAfterDays ?? 60;
  const expenditure = expansionExpenditure(ledger, domain);

  const facetEntries: readonly [string, boolean][] = [
    ["concepts", graph.concepts.status === "evidenced"],
    ["experts", graph.experts.status === "evidenced"],
    ["examples", graph.examples.status === "evidenced"],
    ["frameworks", graph.frameworks.status === "evidenced"],
    ["openQuestions", graph.openQuestions.status === "evidenced"],
    ["timeline", graph.timeline.status === "evidenced"],
    ["taste", graph.taste.status === "evidenced"],
  ];
  const evidencedFacets = facetEntries.filter(([, ok]) => ok).map(([name]) => name);
  const unknownFacets = facetEntries.filter(([, ok]) => !ok).map(([name]) => name);

  const rawRecordCount =
    graph.concepts.items.length +
    graph.experts.items.length +
    graph.examples.items.length +
    graph.frameworks.items.length +
    graph.openQuestions.items.length +
    graph.crossDomainLinks.length +
    graph.interest.rawSignalCount;

  const nowMs = Date.parse(nowIso);
  const datedTimeline = graph.timeline.items.filter(entry => entry.at !== "unknown").map(entry => entry.at);
  const allDates = [
    ...datedTimeline,
    ...(graph.interest.latestEvidenceAt === null ? [] : [graph.interest.latestEvidenceAt]),
    ...(graph.interest.oldestEvidenceAt === null ? [] : [graph.interest.oldestEvidenceAt]),
  ].sort();
  const oldestEvidenceAt = allDates[0] ?? null;
  const latestEvidenceAt = allDates.length > 0 ? allDates[allDates.length - 1]! : null;

  let freshnessStatus: "fresh" | "aging" | "stale" | "unknown" = "unknown";
  if (latestEvidenceAt !== null && Number.isFinite(nowMs)) {
    const latestMs = Date.parse(latestEvidenceAt);
    if (Number.isFinite(latestMs)) {
      const ageDays = Math.max(0, (nowMs - latestMs) / DAY_MS);
      freshnessStatus = ageDays <= freshWithinDays ? "fresh" : ageDays >= staleAfterDays ? "stale" : "aging";
    }
  }

  let stopReason: ExpansionStopReason | null = null;
  if (ledger.stops.has(domain)) stopReason = "owner_stopped";
  else if (graph.interest.supersededByOwner) stopReason = "interest_retracted";
  else if (expenditure.depthUsed >= expenditure.depthCeiling) stopReason = "depth_ceiling_reached";
  else if (expenditure.writesUsed >= expenditure.writesLimit) stopReason = "write_budget_exhausted";
  else if (expenditure.modelCallsUsed >= expenditure.modelCallsLimit || expenditure.tokensUsed >= expenditure.tokensLimit) {
    stopReason = "budget_exhausted";
  }

  const independentEvidenceCount = Math.max(
    graph.dependencyWeight.independentCount,
    graph.interest.independentCount,
  );
  const generatedSummaryReplayCount =
    graph.dependencyWeight.summaryReplayCount + graph.interest.summaryReplayCount;
  const dependentCopyCount =
    graph.dependencyWeight.dependentCopyCount + graph.interest.dependentCount;

  return {
    domain,
    evidencedCoverage: {
      rawRecordCount,
      independentEvidenceCount,
      dependentCopyCount,
      generatedSummaryReplayCount,
      independentWeight: graph.dependencyWeight.independentWeight,
      evidencedFacets,
      unknownFacets,
    },
    freshness: {
      latestEvidenceAt,
      oldestEvidenceAt,
      status: freshnessStatus,
    },
    unansweredQuestions: {
      count: graph.openQuestions.items.length,
      refs: graph.openQuestions.items.map(q => q.ref),
    },
    expenditure,
    stopping: {
      stopped: stopReason !== null,
      reason: stopReason,
      canInspect: true,
      canCorrect: true,
      canUndo: true,
    },
  };
}

export interface TaskDomainSliceRequest {
  readonly domainRef: WorldWireRef<"object">;
  readonly task: string;
  readonly budgetTokens: number;
  readonly valid: WorldValidQuery;
  readonly now?: string;
  readonly tasteRecords?: readonly TasteRecord[];
  readonly tasteContext?: readonly string[];
}

export interface TaskDomainSlice {
  readonly domainRef: WorldWireRef<"object">;
  readonly domainLabel: string;
  readonly task: string;
  readonly budgetTokens: number;
  readonly tokens: number;
  readonly knowledge: readonly DomainFacetNode[];
  readonly tasteAccepted: readonly GroundedTasteItem[];
  readonly tasteRejected: readonly GroundedTasteItem[];
  readonly openQuestions: readonly DomainFacetNode[];
  readonly crossDomainLinks: readonly CrossDomainLink[];
  readonly truncated: boolean;
  readonly widenedScope: false;
  readonly dependencies: WorldDependencies;
  readonly coverage: {
    readonly status: "complete_for_query" | "partial";
    readonly gaps: readonly ViewGap[];
  };
}

function lexicalScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const folded = new Set(normalizeDomainKey(text).match(/[\p{L}\p{N}_]+/gu) ?? []);
  let hits = 0;
  for (const term of terms) if (folded.has(term)) hits += 1;
  return hits;
}

/**
 * Compile a task-bound domain slice (A6).
 * Includes only permitted domain knowledge and domain-isolated taste relevant
 * to the requested task within the token budget. Missing or revoked sources
 * remove dependent content and never widen the query scope.
 */
export function compileTaskDomainSlice(
  frame: WorldFrame,
  request: TaskDomainSliceRequest,
): TaskDomainSlice | null {
  const graph = readDomainGraph(frame, request.domainRef, request.valid, {
    ...(request.now === undefined ? {} : { now: request.now }),
    ...(request.tasteRecords === undefined ? {} : { tasteRecords: request.tasteRecords }),
    ...(request.tasteContext === undefined ? {} : { tasteContext: request.tasteContext }),
  });
  if (graph === null) return null;

  const redactor = createRedactor(frame.ctx.principal, frame.ctx.servingSecrets);
  const terms = queryTerms(request.task);
  const scoreFacet = (item: DomainFacetNode) =>
    lexicalScore(`${redactor.text(item.label)} ${item.relation} ${item.kind}`, terms);
  const scoreTaste = (item: GroundedTasteItem) =>
    lexicalScore(`${redactor.text(item.exampleLabel)} ${item.reasons.map(r => redactor.text(r)).join(" ")} ${item.context.join(" ")}`, terms);

  const knowledgePool = [
    ...graph.concepts.items,
    ...graph.frameworks.items,
    ...graph.examples.items.filter(item => !item.kind.startsWith("taste_")),
  ].sort((a, b) => scoreFacet(b) - scoreFacet(a) || a.claim.token.localeCompare(b.claim.token));

  const acceptedPool = [...graph.taste.accepted]
    .sort((a, b) => scoreTaste(b) - scoreTaste(a) || a.id.localeCompare(b.id));
  const rejectedPool = [...graph.taste.rejected]
    .sort((a, b) => scoreTaste(b) - scoreTaste(a) || a.id.localeCompare(b.id));
  const questionPool = [...graph.openQuestions.items]
    .sort((a, b) => scoreFacet(b) - scoreFacet(a) || a.claim.token.localeCompare(b.claim.token));
  const linkPool = [...graph.crossDomainLinks]
    .sort((a, b) => lexicalScore(redactor.text(b.targetLabel), terms) - lexicalScore(redactor.text(a.targetLabel), terms) || a.claim.token.localeCompare(b.claim.token));

  const knowledge: DomainFacetNode[] = [];
  const tasteAccepted: GroundedTasteItem[] = [];
  const tasteRejected: GroundedTasteItem[] = [];
  const openQuestions: DomainFacetNode[] = [];
  const crossDomainLinks: CrossDomainLink[] = [];
  let truncated = false;

  const buildPayload = () => ({
    domainRef: graph.domainRef,
    domainLabel: graph.domainLabel,
    task: request.task,
    knowledge,
    tasteAccepted,
    tasteRejected,
    openQuestions,
    crossDomainLinks,
    coverage: graph.coverage,
  });
  const fits = () => packetTokens(JSON.stringify(buildPayload())) <= request.budgetTokens;

  // Keep each candidate indivisible with its full provenance and uncertainty qualifiers.
  // Prioritize domain taste examples (accepted + rejected) and task-matching frameworks/concepts.
  const tryPush = <T>(list: T[], item: T) => {
    list.push(item);
    if (!fits()) {
      list.pop();
      truncated = true;
    }
  };

  for (const item of acceptedPool) tryPush(tasteAccepted, item);
  for (const item of rejectedPool) tryPush(tasteRejected, item);
  for (const item of knowledgePool) tryPush(knowledge, item);
  for (const item of questionPool) tryPush(openQuestions, item);
  for (const item of linkPool) tryPush(crossDomainLinks, item);

  const tokens = packetTokens(JSON.stringify(buildPayload()));
  const gaps = new Set<ViewGap>(graph.coverage.gaps);
  if (truncated) gaps.add("traversal_limit");

  return {
    domainRef: graph.domainRef,
    domainLabel: graph.domainLabel,
    task: request.task,
    budgetTokens: request.budgetTokens,
    tokens,
    knowledge,
    tasteAccepted,
    tasteRejected,
    openQuestions,
    crossDomainLinks,
    truncated,
    widenedScope: false,
    dependencies: graph.dependencies,
    coverage: {
      status: gaps.size === 0 ? "complete_for_query" : "partial",
      gaps: [...gaps],
    },
  };
}
