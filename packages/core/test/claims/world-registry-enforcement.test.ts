import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { OWNER } from "../../src/agents";
import {
  WORLD_VOCABULARY,
  type WorldVocabularySpec,
} from "../../src/contracts/world-vocabulary";
import { readWorldView } from "../../src/serving/world-view";
import { worldWriter, type WorldObjectSpec } from "../helpers/world-writer";

const claimCount = (db: Database): number =>
  db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;

function discover(db: Database, kind: "concept" | "situation"): number {
  const view = readWorldView(
    { db, vaultPath: "/synthetic/vault", principal: OWNER },
    {
      operation: kind === "concept" ? "find_concepts" : "find_situations",
      label: "",
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    },
  );
  if (
    "status" in view ||
    view.result.status === "unavailable" ||
    !("matches" in view.result.data)
  )
    throw new Error("discovery unavailable");
  return view.result.data.matches.length;
}

describe("audit probes are permanent refusals at the shared writer", () => {
  test("a literal object on a requirement edge is refused as an object kind", async () => {
    const w = worldWriter();
    try {
      await w.classify("situation:launch", "world/situation");
      const before = claimCount(w.db);
      await expect(
        w.write({
          subject: "situation:launch",
          predicate: "concept.requires",
          object: { literal: "a budget" },
        }),
      ).rejects.toMatchObject({ code: "world_object_kind" });
      expect(claimCount(w.db)).toBe(before);
    } finally {
      w.close();
    }
  });

  test("an unregistered classification value is refused", async () => {
    const w = worldWriter();
    try {
      await expect(
        w.classify("person:ada", "world/person"),
      ).rejects.toMatchObject({ code: "world_vocabulary_value" });
      expect(claimCount(w.db)).toBe(0);
    } finally {
      w.close();
    }
  });

  test("a subject known to be another kind is refused as an endpoint kind", async () => {
    const w = worldWriter();
    try {
      await w.classify("situation:launch", "world/situation");
      await expect(
        w.write({
          subject: "situation:launch",
          predicate: "concept.definition",
          object: { literal: "not a concept" },
        }),
      ).rejects.toMatchObject({ code: "world_endpoint_kind" });
      await w.classify("concept:a", "world/concept");
      await w.classify("situation:b", "world/situation");
      await expect(
        w.write({
          subject: "concept:a",
          predicate: "concept.requires",
          object: { subject: "situation:b" },
        }),
      ).rejects.toMatchObject({ code: "world_endpoint_kind" });
    } finally {
      w.close();
    }
  });
});

describe("a contradictory second classification", () => {
  test("is refused, and the first classification keeps governing the endpoint", async () => {
    const w = worldWriter();
    try {
      await w.classify("x:a", "world/concept");
      const before = claimCount(w.db);
      await expect(w.classify("x:a", "world/situation")).rejects.toMatchObject({ code: "world_endpoint_kind" });
      expect(claimCount(w.db)).toBe(before);
      await expect(
        w.write({ subject: "x:a", predicate: "situation.label", object: { literal: "A situation" } }),
      ).rejects.toMatchObject({ code: "world_endpoint_kind" });
      expect(
        (await w.write({ subject: "x:a", predicate: "concept.label", object: { literal: "A concept" } })).outcome,
      ).toBe("stored");
    } finally {
      w.close();
    }
  });

  test("the same classification twice is not a contradiction", async () => {
    const w = worldWriter();
    try {
      await w.classify("x:a", "world/concept");
      await expect(w.classify("x:a", "world/concept")).resolves.toBeDefined();
    } finally {
      w.close();
    }
  });

  test("a hypothetical or negative first classification does not block a later one", async () => {
    const w = worldWriter();
    try {
      await w.write({ subject: "x:a", predicate: "world.kind", object: { vocabulary: "world/concept" }, mode: "hypothetical" });
      await w.write({ subject: "x:b", predicate: "world.kind", object: { vocabulary: "world/concept" }, polarity: "negative" });
      expect((await w.classify("x:a", "world/situation")).outcome).toBe("stored");
      expect((await w.classify("x:b", "world/situation")).outcome).toBe("stored");
    } finally {
      w.close();
    }
  });

  test("the outcome for a contradictory pair depends on which arrived first, and an unclassified endpoint takes either", async () => {
    const forward = worldWriter();
    const reverse = worldWriter();
    try {
      await forward.classify("x:a", "world/concept");
      await expect(
        forward.write({ subject: "x:a", predicate: "situation.label", object: { literal: "A situation" } }),
      ).rejects.toMatchObject({ code: "world_endpoint_kind" });
      // A predicate that arrived first does not block a later classification: only a known classification refuses.
      expect(
        (await reverse.write({ subject: "x:a", predicate: "situation.label", object: { literal: "A situation" } })).outcome,
      ).toBe("stored");
      expect((await reverse.classify("x:a", "world/concept")).outcome).toBe("stored");
    } finally {
      forward.close();
      reverse.close();
    }
  });
});

describe("registry order independence", () => {
  test("an edge that arrives before either classification is accepted and surfaces only once classified", async () => {
    const w = worldWriter();
    try {
      const edge = await w.write({
        subject: "concept:a",
        predicate: "concept.requires",
        object: { subject: "concept:b" },
      });
      expect(edge.outcome).toBe("stored");
      expect(discover(w.db, "concept")).toBe(0);
      await w.classify("concept:a", "world/concept");
      expect(discover(w.db, "concept")).toBe(1);
      await w.classify("concept:b", "world/concept");
      expect(discover(w.db, "concept")).toBe(2);
    } finally {
      w.close();
    }
  });

  test("only a contradiction with a known classification is refused, and a hypothetical classification does not count", async () => {
    const w = worldWriter();
    try {
      await w.write({
        subject: "concept:a",
        predicate: "world.kind",
        object: { vocabulary: "world/situation" },
        mode: "hypothetical",
      });
      expect(
        (
          await w.write({
            subject: "concept:a",
            predicate: "concept.definition",
            object: { literal: "a definition" },
          })
        ).outcome,
      ).toBe("stored");
      await w.write({
        subject: "concept:b",
        predicate: "world.kind",
        object: { vocabulary: "world/situation" },
        polarity: "negative",
      });
      expect(
        (
          await w.write({
            subject: "concept:b",
            predicate: "concept.definition",
            object: { literal: "a definition" },
          })
        ).outcome,
      ).toBe("stored");
      await w.classify("concept:c", "world/situation");
      await expect(
        w.write({
          subject: "concept:c",
          predicate: "concept.definition",
          object: { literal: "a definition" },
        }),
      ).rejects.toMatchObject({ code: "world_endpoint_kind" });
    } finally {
      w.close();
    }
  });
});

const objectFor = (spec: WorldVocabularySpec, id: string): WorldObjectSpec => {
  const first = spec.objects[0]!;
  return first === "literal"
    ? { literal: "a bounded literal" }
    : first === "vocabulary"
      ? { vocabulary: spec.vocabulary_values![0]! }
      : { subject: `${id}:object` };
};

describe("generated matrix over every registry row", () => {
  for (const spec of WORLD_VOCABULARY) {
    test(spec.predicate, async () => {
      const w = worldWriter();
      try {
        const classify = async (id: string, kind: string) => {
          await w.classify(id, `world/${kind}`);
        };
        const subjectKind =
          spec.subject === "concept" || spec.subject === "situation"
            ? spec.subject
            : null;
        // A well-formed row is stored.
        const ok = `${spec.predicate}:ok`;
        if (subjectKind !== null) await classify(ok, subjectKind);
        if (spec.objects[0] === "concept")
          await classify(`${ok}:object`, "concept");
        expect(
          (
            await w.write({
              subject: ok,
              predicate: spec.predicate,
              object: objectFor(spec, ok),
            })
          ).outcome,
        ).toBe("stored");
        // An object of a kind the row does not allow is refused.
        const kinds = {
          literal: spec.objects.includes("literal"),
          vocabulary: spec.objects.includes("vocabulary"),
          subject:
            spec.objects.includes("concept") ||
            spec.objects.includes("raw_subject"),
        };
        const wrongObjects: [string, WorldObjectSpec][] = [
          ["literal", { literal: "x" }],
          ["vocabulary", { vocabulary: "world/concept" }],
          ["subject", { subject: "any:other" }],
        ];
        for (const [kind, object] of wrongObjects) {
          if (kinds[kind as keyof typeof kinds]) continue;
          const id = `${spec.predicate}:wrong-${kind}`;
          if (subjectKind !== null) await classify(id, subjectKind);
          await expect(
            w.write({ subject: id, predicate: spec.predicate, object }),
          ).rejects.toMatchObject({ code: "world_object_kind" });
        }
        // A closed value list refuses anything outside it.
        if (spec.vocabulary_values !== null) {
          const id = `${spec.predicate}:value`;
          if (subjectKind !== null) await classify(id, subjectKind);
          await expect(
            w.write({
              subject: id,
              predicate: spec.predicate,
              object: { vocabulary: "world/unregistered" },
            }),
          ).rejects.toMatchObject({ code: "world_vocabulary_value" });
        }
        // A subject known to be another kind is refused, for every row that constrains its subject.
        if (spec.subject !== "raw") {
          const id = `${spec.predicate}:kind`;
          await classify(
            id,
            spec.subject === "situation" ? "concept" : "situation",
          );
          if (spec.objects[0] === "concept")
            await classify(`${id}:object`, "concept");
          await expect(
            w.write({
              subject: id,
              predicate: spec.predicate,
              object: objectFor(spec, id),
            }),
          ).rejects.toMatchObject({ code: "world_endpoint_kind" });
        }
        // A second classification that names another endpoint kind is refused.
        if (spec.predicate === "world.kind") {
          const id = `${spec.predicate}:second`;
          await classify(id, "concept");
          await expect(
            w.write({ subject: id, predicate: spec.predicate, object: { vocabulary: "world/situation" } }),
          ).rejects.toMatchObject({ code: "world_endpoint_kind" });
        }
        // A concept object known to be another kind is refused.
        if (
          spec.objects.includes("concept") &&
          !spec.objects.includes("raw_subject")
        ) {
          const id = `${spec.predicate}:objkind`;
          if (subjectKind !== null) await classify(id, subjectKind);
          await classify(`${id}:object`, "situation");
          await expect(
            w.write({
              subject: id,
              predicate: spec.predicate,
              object: { subject: `${id}:object` },
            }),
          ).rejects.toMatchObject({ code: "world_endpoint_kind" });
        }
        // A polarity the row does not list is refused.
        for (const polarity of ["positive", "negative"] as const) {
          if (spec.polarity.includes(polarity)) continue;
          const id = `${spec.predicate}:polarity`;
          if (subjectKind !== null) await classify(id, subjectKind);
          await expect(
            w.write({
              subject: id,
              predicate: spec.predicate,
              object: objectFor(spec, id),
              polarity,
            }),
          ).rejects.toMatchObject({ code: "world_polarity" });
        }
      } finally {
        w.close();
      }
    });
  }
});
