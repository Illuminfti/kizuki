import {
  RETRIEVAL_CONTRACT,
  RETRIEVAL_CONTRACT_MINOR,
} from "@kizuki/core";
import type { PortDescriptor } from "@kizuki/core";

export const EMBEDDED_RETRIEVAL_ID = "kizuki.retrieval.embedded-pg";

export const EMBEDDED_RETRIEVAL_DESCRIPTOR = {
  id: EMBEDDED_RETRIEVAL_ID,
  kind: "retrieval",
  contract: RETRIEVAL_CONTRACT,
  contract_minor: RETRIEVAL_CONTRACT_MINOR,
  supports: ["lexical", "vector", "hybrid", "graph"],
  requires_lease: true,
  optional_package: "@kizuki/retrieval-pg",
} as const satisfies PortDescriptor;
