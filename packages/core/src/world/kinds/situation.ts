import {
  validateSituationCard,
  type SituationCard,
} from "../../contracts/situation-card";
import { sealCard, type KindAssembler } from "./kit";

export const situationAssembler: KindAssembler = {
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
