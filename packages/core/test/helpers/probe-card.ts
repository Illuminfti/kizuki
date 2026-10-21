/**
 * A test-only card for a kind that does not ship, built from the card kit to
 * show what a new kind costs: its shape, the validator of each field, and an
 * assembler. Everything else is the kit and the pipeline.
 */
import {
  cardCodec,
  coverage,
  knownAt,
  knowledgeNode,
  optionalRelation,
  relationList,
  summary,
  type CardKnownAt,
  type CardSummary,
  type Coverage,
  type KnowledgeNode,
  type Relation,
} from "../../src/contracts/world-card-kit";
import { sealCard, type KindAssembler } from "../../src/world/kinds/kit";

export const PROBE_CARD_SCHEMA = "kizuki.probe-card/v1" as const;

export type ProbeCard = {
  readonly schema: typeof PROBE_CARD_SCHEMA;
  readonly probe: KnowledgeNode<"probe">;
  readonly summary: CardSummary | null;
  readonly text: Relation | null;
  readonly answers: readonly Relation[];
  readonly knownAt: CardKnownAt;
  readonly coverage: Coverage;
};

export const validateProbeCard = cardCodec<ProbeCard, "probe-card">({
  schema: PROBE_CARD_SCHEMA,
  label: "probe-card",
  fields: {
    probe: (value) => knowledgeNode(value, "probe"),
    summary,
    text: optionalRelation,
    answers: relationList,
    knownAt,
    coverage,
  },
});

export const probeAssembler: KindAssembler = {
  kind: "probe",
  // This test-only assembler has no background summary job. Its nullable
  // placeholder must not claim support for consolidation it cannot perform.
  consolidation: false,
  assemble({ node, own, summary, coverage }) {
    const texts = own.filter((item) => item.predicate === "probe.text");
    const card: ProbeCard = {
      schema: PROBE_CARD_SCHEMA,
      probe: { ...node, kind: "probe" },
      summary,
      text: texts.length === 1 ? texts[0]! : null,
      answers: own.filter((item) => item.predicate === "probe.candidate_answer"),
      knownAt: { kind: "current" },
      coverage,
    };
    return sealCard(card, validateProbeCard, "probe");
  },
};
