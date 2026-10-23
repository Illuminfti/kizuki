import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import type { CoreSemanticAssetSet } from "./core-semantic";
import { validateScopedBranch, UNION_SEMANTIC_PROTOCOL, type ScopedExtractBranch } from "./union-propositions";
import originalCorpus from "./core-semantic-offered-corpus.json";
import originalContract from "./core-semantic-offered-contract.json";
import corpusJson from "./core-semantic-union-corpus.json";
import contractJson from "./core-semantic-union-contract.json";
import { validateQualificationInputPolicy, type QualificationInputPolicy } from "./input-planning";

export const UNION_SPLIT = "union22" as const;
export const UNION_INPUT_POLICY: QualificationInputPolicy = Object.freeze({ schema: "kizuki.qualification-input-policy/v1", max_input_tokens: 32_000, input_token_overhead: 24_000, max_output_tokens: 8_192 });
export function validateUnionInputPolicy(raw: unknown): QualificationInputPolicy {
  const policy = validateQualificationInputPolicy(raw);
  if (canonicalJson(policy) !== canonicalJson(UNION_INPUT_POLICY)) throw Error("union requires the frozen input policy");
  return policy;
}
const appended = ["union-direct-question-person", "union-attributed-question-person", "union-unfilled-and-hypothetical-negative",
  "union-skill-framework-procedure-guide", "union-typed-promises-decisions-and-situation"];
export function unionSemanticAssets(): CoreSemanticAssetSet {
  // No implicit, computed-in-place freeze: a reviewed immutable file must exist.
  const freeze = JSON.parse(readFileSync(join(import.meta.dir, "core-semantic-union-freeze.json"), "utf8")) as { schema: string; protocol: string; split: string; limits: unknown; input_policy: unknown; files: Record<string, { sha256: string; bytes: number }> };
  if (freeze.schema !== "kizuki.core-semantic-union-freeze/v1" || freeze.protocol !== UNION_SEMANTIC_PROTOCOL || freeze.split !== UNION_SPLIT ||
      canonicalJson(freeze.input_policy) !== canonicalJson(UNION_INPUT_POLICY) || canonicalJson(freeze.limits) !== canonicalJson({ propositions_per_branch: 32, source_local_entities_per_branch: 8,
        records_per_request: 8, structured_subjects_per_record: 8, contexts_per_proposition: 4, complete_branches: 3, complete_perspective_variants: 4 })) throw Error("union policy/limits freeze mismatch");
  for (const name of ["core-semantic-union-corpus.json", "core-semantic-union-contract.json", "core-semantic-union.md"]) {
    const bytes = readFileSync(join(import.meta.dir, name)), pin = freeze.files[name];
    if (!pin || pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes)) throw Error("union asset freeze mismatch");
  }
  return { split: UNION_SPLIT, corpus: corpusJson as CoreSemanticAssetSet["corpus"], contract: contractJson as CoreSemanticAssetSet["contract"],
    corpus_sha256: freeze.files["core-semantic-union-corpus.json"]!.sha256, contract_sha256: freeze.files["core-semantic-union-contract.json"]!.sha256 };
}

/** Fixed nine-kind split, not a general evaluator/corpus composition mechanism. */
export function validateUnionContract(corpus: CoreSemanticAssetSet["corpus"], contract: CoreSemanticAssetSet["contract"], registry: WorldRegistry): void {
  if (corpus.schema !== "kizuki.core-semantic-corpus/v4" || corpus.synthetic !== true || corpus.split !== "prospective_union22" || corpus.cases.length !== 22 ||
      contract.schema !== "kizuki.core-semantic-contract/v4" || contract.protocol !== UNION_SEMANTIC_PROTOCOL || corpus.version !== contract.corpus_version || contract.cases.length !== 22 ||
      canonicalJson(corpus.cases.slice(0, 17)) !== canonicalJson(originalCorpus.cases) ||
      canonicalJson(contract.cases.slice(0, 17).filter(c => c.case_id !== "offered-concept-cutting-relations")) !==
        canonicalJson(originalContract.cases.filter(c => c.case_id !== "offered-concept-cutting-relations")) ||
      canonicalJson(corpus.cases.slice(17).map(c => c.id)) !== canonicalJson(appended) ||
      canonicalJson(contract.cases.map(c => c.case_id)) !== canonicalJson(corpus.cases.map(c => c.id)) ||
      canonicalJson(contract.legacy_extra_policy) !== canonicalJson(originalContract.legacy_extra_policy) || new Set(corpus.cases.map(c => c.id)).size !== 22) throw Error("invalid fixed union assets");
  const covered = new Set<string>();
  for (const item of [...corpus.cases.slice(17), corpus.cases.find(c => c.id === "offered-concept-cutting-relations")!]) {
    const inheritedAlias = item.id === "offered-concept-cutting-relations";
    if ((!inheritedAlias && item.kind !== "mixed") || item.records.length < 1 || item.records.length > 8 || new Set(item.records.map(r => r.id)).size !== item.records.length) throw Error("invalid union case");
    for (const record of item.records) {
      if (!record.id || !record.text || record.text.length > 8_000 || record.subjects.length !== 0 || !Array.isArray(record.structured_subjects) || record.structured_subjects.length > 8 ||
          new Set(record.structured_subjects.map(s => s.subject_id)).size !== record.structured_subjects.length) throw Error("invalid union record");
      for (const s of record.structured_subjects) if (!s.subject_id || !s.display_name || !["about", "from", "to"].includes(s.role) || Object.keys(s).sort().join() !== ["display_name", "role", "subject_id"].sort().join()) throw Error("invalid union structured subject");
    }
    const rule = contract.cases.find(r => r.case_id === item.id)!;
    if (rule.expectation === "abstain") {
      if (item.id !== appended[2] || rule.forbidden_assertions.length === 0) throw Error("invalid union abstention");
      continue;
    }
    if (!("branches" in rule) || rule.branches.length < 1 || rule.branches.length > 3 || new Set(rule.branches.map(b => b.id)).size !== rule.branches.length) throw Error("invalid union branches");
    if (inheritedAlias) {
      const [completeRaw, partialRaw] = rule.branches;
      if (completeRaw === undefined || partialRaw === undefined || !("scope" in completeRaw) || !("scope" in partialRaw)) throw Error("invalid local alias alternatives");
      const complete = completeRaw as ScopedExtractBranch, partial = partialRaw as ScopedExtractBranch;
      const requiredNomination = canonicalJson({
        alias: { mode: "source_occurrence", record: "r1", label: "Ochre Cutreserve" },
        canonical: { mode: "source_occurrence", record: "r1", label: "Thistle Spareband" },
      });
      if (rule.branches.length !== 2 || complete?.id !== "complete-local-alias" || partial?.id !== "partial-local-alias" ||
          complete.scope !== "world-union/v1" || partial.scope !== "world-union/v1" ||
          canonicalJson(complete.local_alias_nomination) !== requiredNomination || canonicalJson(partial.local_alias_nomination) !== requiredNomination ||
          canonicalJson(complete.propositions.map(p => p.rule_id)) !== canonicalJson(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"]) ||
          canonicalJson(partial.propositions.map(p => p.rule_id)) !== canonicalJson(["p1", "p2", "p3", "p4", "p5", "p7", "p8", "p9", "p10", "p11"])) throw Error("invalid local alias alternatives");
    }
    for (const branch of rule.branches) {
      if (!("scope" in branch)) throw Error("union branch scope missing");
      validateScopedBranch(item, branch, registry);
      for (const p of branch.propositions) covered.add(p.predicate);
    }
  }
  for (const rule of contract.cases.slice(0, 17)) if (rule.expectation === "extract") {
    const branches = "branches" in rule ? rule.branches : [rule];
    for (const b of branches) for (const id of "propositions" in b ? b.propositions.map(p => p.predicate) : ["world.kind", `${b.classification.kind.slice(6)}.label`, ...b.details.map(d => d.predicate)]) covered.add(id);
  }
  if (canonicalJson([...covered].sort()) !== canonicalJson(registry.offered.vocabulary.map(r => r.predicate).sort())) throw Error("union offered predicate coverage mismatch");
}
