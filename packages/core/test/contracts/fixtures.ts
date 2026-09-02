import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RetrievalConformanceFixtures,
} from "../../src/contracts/conformance/retrieval";
import type { PortContext, PortDescriptor } from "../../src/contracts/ports";
import type {
  RetrievalDoc,
  RetrievalQuery,
} from "../../src/contracts/retrieval";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";

export const SYNTHETIC_DOCS: readonly RetrievalDoc[] = [
  {
    doc_id: "page:grace",
    kind: "page",
    title: "Grace at Acme",
    text: "Grace runs partnerships at Acme.",
    sensitivity: "personal",
    taint: "clean",
    authority: "connector_evidence",
    subjects: ["person:grace"],
    provenance: ["event:acme-note"],
    occurred_at: "2026-08-14T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
  {
    doc_id: "claim:grace-email",
    kind: "claim",
    title: "Grace contact",
    text: "Grace can be reached at grace@acme.test.",
    sensitivity: "private",
    taint: "clean",
    authority: "model_inference",
    subjects: ["person:grace"],
    provenance: ["event:acme-note"],
    occurred_at: "2026-08-14T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
  {
    doc_id: "event:unlabeled",
    kind: "event",
    title: "Unlabeled source",
    text: "Grace private unlabeled source.",
    sensitivity: null,
    taint: "quoted",
    authority: "connector_evidence",
    subjects: ["person:grace"],
    provenance: ["event:unlabeled"],
    occurred_at: "2026-08-15T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
];

export const SYNTHETIC_QUERY: RetrievalQuery = {
  text: "grace",
  mode: "lexical",
  scope: { kinds: ["page", "claim"], subjects: ["person:grace"] },
  ceiling: "private",
  limit: 10,
  deadline_ms: 1_000,
};

export const RETRIEVAL_FIXTURES: RetrievalConformanceFixtures = {
  docs: SYNTHETIC_DOCS,
  query: SYNTHETIC_QUERY,
  expected_doc_ids: ["claim:grace-email", "page:grace"],
  delete_ids: ["page:grace"],
};

export interface TemporaryPortContext {
  root: string;
  ctx: PortContext;
  cleanup(): void;
}

export function temporaryPortContext(
  descriptor: PortDescriptor,
  secrets: PortContext["secrets"] = async () => "synthetic-contract-token",
): TemporaryPortContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-contract-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(
    vaultPath,
    ".kizuki",
    descriptor.kind,
    descriptor.id,
  );
  mkdirSync(dataDir, { recursive: true });
  return {
    root,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config: {},
      secrets,
      clock: () => FIXED_NOW,
      logger: () => {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
