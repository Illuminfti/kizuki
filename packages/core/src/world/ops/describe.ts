import { WORLD_VOCABULARY_SCHEMA } from "../../contracts/world-vocabulary";
import { WORLD_KINDS, worldKindState } from "./kinds";
import type { WorldKindPopulation } from "./kinds";
import type { BuildOp } from "./types";
import { worldOpInputKeys } from "./types";

export const WORLD_DESCRIBE_SCHEMA = "kizuki.world-describe/v1" as const;

export type WorldDescribe = {
  readonly schema: typeof WORLD_DESCRIBE_SCHEMA;
  readonly vocabulary: typeof WORLD_VOCABULARY_SCHEMA;
  readonly kinds: readonly {
    readonly id: string;
    readonly state: "shipped" | "dark";
    readonly population: WorldKindPopulation;
  }[];
  readonly operations: readonly {
    readonly name: string;
    readonly inputKeys: readonly string[];
    readonly resultSchemas: readonly string[];
  }[];
};

/** What this build can serve. It reads no storage, so nothing about a vault or a principal can change it. */
export const describeOp: BuildOp = {
  source: "build",
  name: "describe",
  dataSchemas: [WORLD_DESCRIBE_SCHEMA],
  run: (registry) => {
    const data: WorldDescribe = {
      schema: WORLD_DESCRIBE_SCHEMA,
      vocabulary: WORLD_VOCABULARY_SCHEMA,
      kinds: WORLD_KINDS.map(({ id, population }) => ({
        id,
        state: worldKindState(population),
        population,
      })),
      operations: registry.map((op) => ({
        name: op.name,
        inputKeys: worldOpInputKeys(op),
        resultSchemas: [...op.dataSchemas],
      })),
    };
    return { status: "data", data, gaps: null };
  },
};
