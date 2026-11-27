import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ONTOLOGY_SCHEMA_VERSION,
  checkAnswerable,
  compileOntologyFromVault,
  dedupeStrings,
  defaultOntologyDbPath,
  exportOssieJson,
  exportOssieModel,
  exportOssieYaml,
  findJoinPath,
  importOssieModel,
  normalizeTermKey,
  openOntologyStore,
  retrieveOntology,
} from "@kizuki/ontology";
import type {
  OntologyRetrievePurpose,
  OntologyStatus,
  OntologyStore,
  OntologyTerm,
} from "@kizuki/ontology";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { clean, errorText, jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const RETRIEVE_PURPOSES = ["information", "relations", "metrics", "all"] as const;
const EXPORT_FORMATS = ["ossie-yaml", "json"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function parseIntegerOption(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  flagName: string,
): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new UsageError(`invalid ${flagName} (expected ${min}..${max})`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`invalid ${flagName} (expected ${min}..${max})`);
  }
  return value;
}

function parsePurposeOption(raw: string | undefined): OntologyRetrievePurpose {
  if (raw === undefined) return "all";
  if (!(RETRIEVE_PURPOSES as readonly string[]).includes(raw)) {
    throw new UsageError(
      `invalid --purpose (expected ${RETRIEVE_PURPOSES.join("|")})`,
    );
  }
  return raw as OntologyRetrievePurpose;
}

function parseExportFormat(raw: string | undefined): ExportFormat {
  if (raw === undefined) return "ossie-yaml";
  if (!(EXPORT_FORMATS as readonly string[]).includes(raw)) {
    throw new UsageError(
      `invalid --format (expected ${EXPORT_FORMATS.join("|")})`,
    );
  }
  return raw as ExportFormat;
}

/**
 * Strictly read-only status inspection. Never creates `ontology.sqlite` or
 * writes WAL/SHM files on an untouched vault.
 */
function readOntologyStatusReadOnly(dbPath: string): {
  compiled: boolean;
  status: OntologyStatus;
} {
  if (!existsSync(dbPath)) {
    return {
      compiled: false,
      status: {
        dbPath,
        termCount: 0,
        certifiedTermCount: 0,
        draftTermCount: 0,
        familyCount: 0,
        relationCount: 0,
        defaultJoinCount: 0,
        metricCount: 0,
        certifiedMetricCount: 0,
        certificationReceiptCount: 0,
        lastCompiledAt: null,
        schemaVersion: ONTOLOGY_SCHEMA_VERSION,
      },
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((row) => row.name),
    );
    const countOf = (sql: string, table: string): number => {
      if (!tables.has(table)) return 0;
      return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
    };
    const metaOf = (key: string): string | null => {
      if (!tables.has("ontology_meta")) return null;
      return (
        db
          .query<{ value: string }, [string]>(
            "SELECT value FROM ontology_meta WHERE key = ?",
          )
          .get(key)?.value ?? null
      );
    };

    const termCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_terms",
      "ontology_terms",
    );
    const certifiedTermCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_terms WHERE certification = 'certified'",
      "ontology_terms",
    );
    const familyCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_term_families",
      "ontology_term_families",
    );
    const relationCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_relations",
      "ontology_relations",
    );
    const defaultJoinCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_relations WHERE is_default_join = 1",
      "ontology_relations",
    );
    const metricCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_metrics",
      "ontology_metrics",
    );
    const certifiedMetricCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_metrics WHERE certification = 'certified'",
      "ontology_metrics",
    );
    const certificationReceiptCount = countOf(
      "SELECT COUNT(*) AS count FROM ontology_certifications",
      "ontology_certifications",
    );
    const lastCompiledAt = metaOf("last_compiled_at");
    const schemaVersion = metaOf("schema_version") ?? ONTOLOGY_SCHEMA_VERSION;
    const compiled =
      lastCompiledAt !== null || termCount > 0 || metricCount > 0;

    return {
      compiled,
      status: {
        dbPath,
        termCount,
        certifiedTermCount,
        draftTermCount: termCount - certifiedTermCount,
        familyCount,
        relationCount,
        defaultJoinCount,
        metricCount,
        certifiedMetricCount,
        certificationReceiptCount,
        lastCompiledAt,
        schemaVersion,
      },
    };
  } finally {
    db.close();
  }
}

function resolveTerm(
  store: OntologyStore,
  idOrName: string,
): OntologyTerm | null {
  const trimmed = idOrName.trim();
  if (trimmed.length === 0) return null;
  const byId = store.getTerm(trimmed, { sensitivityCeiling: "private" });
  if (byId !== null) return byId;
  const byKey = store.getTermByKey(trimmed, { sensitivityCeiling: "private" });
  if (byKey !== null) return byKey;

  const lower = trimmed.toLowerCase();
  const norm = normalizeTermKey(trimmed);
  for (const term of store.listTerms({ sensitivityCeiling: "private" })) {
    if (term.canonicalName.toLowerCase() === lower) return term;
    if (
      term.synonyms.some(
        (syn) => syn.toLowerCase() === lower || normalizeTermKey(syn) === norm,
      )
    ) {
      return term;
    }
  }
  return null;
}

export const ONTOLOGY_SCHEMA = {
  options: [
    "--purpose",
    "--max-chars",
    "--limit",
    "--max-hops",
    "--description",
    "--synonym",
    "--name",
    "--domain",
    "--kind",
    "--format",
    "--out",
    "--file",
  ],
  flags: ["--json", "--replace"],
  defaults: {
    "--purpose": "all",
    "--max-chars": "4000",
    "--limit": "20",
    "--max-hops": "6",
    "--format": "ossie-yaml",
  },
  bounds: {
    "--purpose": "information|relations|metrics|all",
    "--max-chars": "64..32000",
    "--limit": "1..100",
    "--max-hops": "1..12",
    "--format": "ossie-yaml|json",
  },
} as const satisfies CommandHelpSchema;

export const ontologyCommand: Command = {
  name: "ontology",
  usage:
    "ontology <status|compile|search|term|path|check|certify|export|import> [options] [--json]",
  summary:
    "compile, query, certify, check answerability, and export/import the local semantic ontology",
  schema: ONTOLOGY_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...ONTOLOGY_SCHEMA.options],
      repeatableOptions: ["--synonym"],
      flags: [...ONTOLOGY_SCHEMA.flags],
    });
    const [subcommand, ...rest] = parsed.positionals;
    if (subcommand === undefined) throw new UsageError(this.usage);
    const asJson = parsed.flags.has("--json");

    if (subcommand === "status") {
      if (rest.length !== 0) throw new UsageError("ontology status [--json]");
      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          const { compiled, status } = readOntologyStatusReadOnly(dbPath);
          const payload = {
            subcommand: "status" as const,
            compiled,
            ...status,
          };
          if (asJson) {
            io.out(jsonEnvelope("ontology", "ok", payload));
            return 0;
          }
          io.out(
            `compiled=${compiled ? "yes" : "no"} terms=${status.termCount} certified=${status.certifiedTermCount} draft=${status.draftTermCount} families=${status.familyCount}`,
          );
          io.out(
            `relations=${status.relationCount} default_joins=${status.defaultJoinCount} metrics=${status.metricCount} certified_metrics=${status.certifiedMetricCount} receipts=${status.certificationReceiptCount}`,
          );
          io.out(
            `last_compiled_at=${status.lastCompiledAt ?? "never"} schema_version=${status.schemaVersion}`,
          );
          return 0;
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "compile") {
      if (rest.length !== 0) throw new UsageError("ontology compile [--json]");
      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          const store = openOntologyStore(dbPath);
          try {
            const report = compileOntologyFromVault(ctx.db, store);
            const payload = {
              subcommand: "compile" as const,
              dbPath,
              ...report,
            };
            if (asJson) {
              io.out(jsonEnvelope("ontology", "ok", payload));
              return 0;
            }
            io.out(
              `compiled terms=${report.termsCompiled} created=${report.termsCreated} updated=${report.termsUpdated} preserved_certified=${report.preservedCertified}`,
            );
            io.out(
              `families=${report.familiesDetected} relations=${report.relationsCompiled} default_joins=${report.defaultJoinsSelected} metrics=${report.metricsCompiled}`,
            );
            io.out(
              `sources=${report.sourceTables.join(",") || "none"} compiled_at=${report.compiledAt}`,
            );
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "search") {
      if (rest.length !== 1 || rest[0] === undefined || rest[0].trim().length === 0) {
        throw new UsageError(
          "ontology search <query> [--purpose information|relations|metrics|all] [--max-chars N] [--limit N] [--json]",
        );
      }
      const query = rest[0];
      const purpose = parsePurposeOption(parsed.options.get("--purpose"));
      const maxChars = parseIntegerOption(
        parsed.options.get("--max-chars"),
        4000,
        64,
        32000,
        "--max-chars",
      );
      const limit = parseIntegerOption(
        parsed.options.get("--limit"),
        20,
        1,
        100,
        "--limit",
      );

      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            const emptyPayload = {
              subcommand: "search" as const,
              compiled: false,
              query,
              purpose,
              sensitivityCeiling: "private" as const,
              terms: [],
              relations: [],
              joinPaths: [],
              metrics: [],
              rendered: "",
              truncated: false,
              totalChars: 0,
            };
            if (asJson) {
              io.out(
                jsonEnvelope("ontology", "ok", emptyPayload, {
                  warnings: ["ontology not compiled yet; run: kizuki ontology compile"],
                }),
              );
            } else {
              io.out("ontology not compiled yet; run: kizuki ontology compile");
            }
            return 0;
          }

          const store = openOntologyStore(dbPath);
          try {
            const result = retrieveOntology(store, query, {
              purpose,
              maxChars,
              limit,
              sensitivityCeiling: "private",
            });
            if (asJson) {
              io.out(
                jsonEnvelope("ontology", "ok", {
                  subcommand: "search" as const,
                  compiled: true,
                  ...result,
                }),
              );
              return 0;
            }
            io.out(result.rendered);
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "term") {
      if (rest.length !== 1 || rest[0] === undefined || rest[0].trim().length === 0) {
        throw new UsageError("ontology term <id-or-name> [--json]");
      }
      const target = rest[0];
      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "term" as const, query: target, error: "not_found" },
                  { error: { code: "not_found", message: "ontology not compiled" } },
                ),
              );
            } else {
              io.err("error: ontology not compiled yet; run: kizuki ontology compile");
            }
            return 1;
          }

          const store = openOntologyStore(dbPath);
          try {
            const term = resolveTerm(store, target);
            if (term === null) {
              if (asJson) {
                io.out(
                  jsonEnvelope(
                    "ontology",
                    "error",
                    { subcommand: "term" as const, query: target, error: "not_found" },
                    { error: { code: "not_found", message: `term not found: ${target}` } },
                  ),
                );
              } else {
                io.err(`error: term not found: ${clean(target)}`);
              }
              return 1;
            }

            const family =
              term.familyId !== null ? store.getTermFamily(term.familyId) : null;
            const relations = store
              .listRelations({ sensitivityCeiling: "private" })
              .filter(
                (rel) =>
                  rel.sourceTermId === term.termId ||
                  rel.targetTermId === term.termId,
              );
            const metrics = store.listMetrics({
              termId: term.termId,
              sensitivityCeiling: "private",
            });
            const certifications = store.listCertifications(term.termId);

            const payload = {
              subcommand: "term" as const,
              term,
              family,
              relations,
              metrics,
              certifications,
            };
            if (asJson) {
              io.out(jsonEnvelope("ontology", "ok", payload));
              return 0;
            }
            io.out(
              `term id=${clean(term.termId)} name=${clean(term.canonicalName)} key=${clean(term.normalizedKey)} kind=${clean(term.kind)} domain=${clean(term.domain)} sensitivity=${term.sensitivity} certification=${term.certification}`,
            );
            if (term.certifiedBy !== null || term.certifiedAt !== null) {
              io.out(
                `certified_by=${clean(term.certifiedBy ?? "")} certified_at=${clean(term.certifiedAt ?? "")}`,
              );
            }
            if (term.description.length > 0) {
              io.out(`description=${clean(term.description)}`);
            }
            if (term.synonyms.length > 0) {
              io.out(`synonyms=${term.synonyms.map(clean).join(", ")}`);
            }
            if (family !== null) {
              io.out(
                `family id=${clean(family.familyId)} prefix=${clean(family.prefix)} domain=${clean(family.domain)} twins=${family.twinCount}`,
              );
            }
            if (term.attributes.length > 0) {
              io.out(
                `attributes=${term.attributes.map((a) => clean(a.name)).join(", ")}`,
              );
            }
            for (const rel of relations) {
              io.out(
                `relation ${clean(rel.sourceTermId)} --[${clean(rel.relationKind)}${rel.isDefaultJoin ? "*" : ""}]--> ${clean(rel.targetTermId)} ev=${rel.evidenceCount} conf=${rel.confidence.toFixed(2)}`,
              );
            }
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "path") {
      if (
        rest.length !== 2 ||
        rest[0] === undefined ||
        rest[1] === undefined ||
        rest[0].trim().length === 0 ||
        rest[1].trim().length === 0
      ) {
        throw new UsageError("ontology path <from> <to> [--max-hops N] [--json]");
      }
      const fromArg = rest[0];
      const toArg = rest[1];
      const maxHops = parseIntegerOption(
        parsed.options.get("--max-hops"),
        6,
        1,
        12,
        "--max-hops",
      );

      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "path" as const, from: fromArg, to: toArg, error: "not_found" },
                  { error: { code: "not_found", message: "ontology not compiled" } },
                ),
              );
            } else {
              io.err("error: ontology not compiled yet; run: kizuki ontology compile");
            }
            return 1;
          }

          const store = openOntologyStore(dbPath);
          try {
            const fromTerm = resolveTerm(store, fromArg);
            const toTerm = resolveTerm(store, toArg);
            if (fromTerm === null || toTerm === null) {
              const missingLabel = fromTerm === null ? fromArg : toArg;
              if (asJson) {
                io.out(
                  jsonEnvelope(
                    "ontology",
                    "error",
                    {
                      subcommand: "path" as const,
                      from: fromArg,
                      to: toArg,
                      error: "not_found",
                      missing: missingLabel,
                    },
                    { error: { code: "not_found", message: `term not found: ${missingLabel}` } },
                  ),
                );
              } else {
                io.err(`error: term not found: ${clean(missingLabel)}`);
              }
              return 1;
            }

            const terms = store.listTerms({ sensitivityCeiling: "private" });
            const termMap = new Map(terms.map((t) => [t.termId, t]));
            const relations = store.listRelations({ sensitivityCeiling: "private" });
            const joinPath = findJoinPath(relations, fromTerm.termId, toTerm.termId, {
              sensitivityCeiling: "private",
              termMap,
              maxHops,
            });

            const payload = {
              subcommand: "path" as const,
              from: fromTerm,
              to: toTerm,
              found: joinPath !== null,
              path: joinPath,
            };
            if (asJson) {
              io.out(jsonEnvelope("ontology", "ok", payload));
              return 0;
            }
            if (joinPath === null) {
              io.out(
                `no join path found between ${clean(fromTerm.canonicalName)} and ${clean(toTerm.canonicalName)}`,
              );
            } else {
              io.out(
                `path hops=${joinPath.hops} evidence=${joinPath.totalEvidence} default_joins=${joinPath.allDefaultJoins ? "yes" : "no"}: ${clean(joinPath.pathString)}`,
              );
            }
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "check") {
      if (rest.length !== 1 || rest[0] === undefined || rest[0].trim().length === 0) {
        throw new UsageError("ontology check <question> [--max-hops N] [--json]");
      }
      const question = rest[0];
      const maxJoinHops = parseIntegerOption(
        parsed.options.get("--max-hops"),
        6,
        1,
        12,
        "--max-hops",
      );

      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            const uncompiled = {
              subcommand: "check" as const,
              compiled: false,
              question,
              sensitivityCeiling: "private" as const,
              candidates: [],
              coverage: 0,
              verdict: "unanswerable" as const,
              resolved: [],
              missing: [],
              joinPaths: [],
              suggestedMetrics: [],
              clarification:
                "Ontology has not been compiled yet; run `kizuki ontology compile` first.",
            };
            if (asJson) {
              io.out(
                jsonEnvelope("ontology", "ok", uncompiled, {
                  warnings: ["ontology not compiled yet; run: kizuki ontology compile"],
                }),
              );
            } else {
              io.out("verdict=unanswerable coverage=0.00 (ontology not compiled)");
            }
            return 0;
          }

          const store = openOntologyStore(dbPath);
          try {
            const report = checkAnswerable(store, question, {
              sensitivityCeiling: "private",
              maxJoinHops,
            });
            if (asJson) {
              io.out(
                jsonEnvelope("ontology", "ok", {
                  subcommand: "check" as const,
                  compiled: true,
                  ...report,
                }),
              );
              return 0;
            }
            io.out(
              `verdict=${report.verdict} coverage=${report.coverage.toFixed(2)} resolved=${report.resolved.length} missing=${report.missing.length} join_paths=${report.joinPaths.length}`,
            );
            if (report.resolved.length > 0) {
              io.out(
                `resolved=${report.resolved.map((r) => `${clean(r.canonicalName)}(${r.matchedBy},${r.certification})`).join(", ")}`,
              );
            }
            if (report.missing.length > 0) {
              io.out(`missing=${report.missing.map(clean).join(", ")}`);
            }
            for (const jp of report.joinPaths) {
              io.out(`join_path hops=${jp.hops} ev=${jp.totalEvidence}: ${clean(jp.pathString)}`);
            }
            if (report.clarification !== null) {
              io.out(`clarification=${clean(report.clarification)}`);
            }
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "certify") {
      if (rest.length !== 1 || rest[0] === undefined || rest[0].trim().length === 0) {
        throw new UsageError(
          'ontology certify <term-id> [--description "..."] [--synonym "..."] [--name "..."] [--domain "..."] [--kind "..."] [--json]',
        );
      }
      const target = rest[0];
      const description = parsed.options.get("--description");
      const addedSynonyms = parsed.repeated.get("--synonym");
      const canonicalName = parsed.options.get("--name");
      const domain = parsed.options.get("--domain");
      const kind = parsed.options.get("--kind");

      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "certify" as const, target, error: "not_found" },
                  { error: { code: "not_found", message: "ontology not compiled" } },
                ),
              );
            } else {
              io.err("error: ontology not compiled yet; run: kizuki ontology compile");
            }
            return 1;
          }

          const store = openOntologyStore(dbPath);
          try {
            const existing = resolveTerm(store, target);
            if (existing === null) {
              if (asJson) {
                io.out(
                  jsonEnvelope(
                    "ontology",
                    "error",
                    { subcommand: "certify" as const, target, error: "not_found" },
                    { error: { code: "not_found", message: `term not found: ${target}` } },
                  ),
                );
              } else {
                io.err(`error: term not found: ${clean(target)}`);
              }
              return 1;
            }

            const mergedSynonyms =
              addedSynonyms !== undefined && addedSynonyms.length > 0
                ? dedupeStrings([...existing.synonyms, ...addedSynonyms])
                : undefined;

            const result = store.certifyTerm({
              termId: existing.termId,
              actor: "owner",
              ...(canonicalName !== undefined ? { canonicalName } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(mergedSynonyms !== undefined ? { synonyms: mergedSynonyms } : {}),
              ...(domain !== undefined ? { domain } : {}),
              ...(kind !== undefined ? { kind } : {}),
              certification: "certified",
            });

            const payload = {
              subcommand: "certify" as const,
              term: result.term,
              receipt: result.receipt,
            };
            if (asJson) {
              io.out(jsonEnvelope("ontology", "ok", payload));
              return 0;
            }
            io.out(
              `certified term=${clean(result.term.termId)} name=${clean(result.term.canonicalName)} receipt=${clean(result.receipt.receiptId)}`,
            );
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "export") {
      if (rest.length !== 0) {
        throw new UsageError(
          "ontology export [--format ossie-yaml|json] [--out FILE] [--json]",
        );
      }
      const format = parseExportFormat(parsed.options.get("--format"));
      const outFile = parsed.options.get("--out");

      return withReadVault(
        io,
        async (ctx) => {
          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          if (!existsSync(dbPath)) {
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "export" as const, format, error: "not_compiled" },
                  { error: { code: "not_compiled", message: "ontology not compiled" } },
                ),
              );
            } else {
              io.err("error: ontology not compiled yet; run: kizuki ontology compile");
            }
            return 1;
          }

          const store = openOntologyStore(dbPath);
          try {
            const opts = { sensitivityCeiling: "private" as const };
            const model = exportOssieModel(store, opts);
            const content =
              format === "json"
                ? exportOssieJson(store, opts)
                : exportOssieYaml(store, opts);

            if (outFile !== undefined) {
              const targetPath = resolve(outFile);
              mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
              writeFileSync(targetPath, content, { encoding: "utf8", mode: 0o600 });
              const payload = {
                subcommand: "export" as const,
                format,
                out: targetPath,
                bytes: Buffer.byteLength(content, "utf8"),
                concepts: model.concepts.length,
                term_families: model.term_families.length,
                relationships: model.relationships.length,
                metrics: model.metrics.length,
              };
              if (asJson) {
                io.out(jsonEnvelope("ontology", "ok", payload));
              } else {
                io.out(
                  `exported format=${format} out=${clean(targetPath)} concepts=${model.concepts.length} relationships=${model.relationships.length} metrics=${model.metrics.length}`,
                );
              }
              return 0;
            }

            if (asJson) {
              io.out(
                jsonEnvelope("ontology", "ok", {
                  subcommand: "export" as const,
                  format,
                  content,
                  model,
                }),
              );
              return 0;
            }

            io.out(content.replace(/\n$/, ""));
            return 0;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "import") {
      if (rest.length !== 0) {
        throw new UsageError("ontology import --file FILE [--replace] [--json]");
      }
      const fileArg = parsed.options.get("--file");
      if (fileArg === undefined || fileArg.trim().length === 0) {
        throw new UsageError("ontology import requires --file FILE");
      }
      const replace = parsed.flags.has("--replace");
      const filePath = resolve(fileArg);

      return withReadVault(
        io,
        async (ctx) => {
          if (!existsSync(filePath)) {
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "import" as const, file: filePath, error: "file_not_found" },
                  { error: { code: "file_not_found", message: `file not found: ${filePath}` } },
                ),
              );
            } else {
              io.err(`error: file not found: ${clean(filePath)}`);
            }
            return 1;
          }

          const dbPath = defaultOntologyDbPath(ctx.vaultPath);
          const store = openOntologyStore(dbPath);
          try {
            const rawText = readFileSync(filePath, "utf8");
            const report = importOssieModel(store, rawText, {
              preserveCertified: true,
              replace,
            });
            const payload = {
              subcommand: "import" as const,
              file: filePath,
              replace,
              ...report,
            };
            if (asJson) {
              io.out(jsonEnvelope("ontology", "ok", payload));
              return 0;
            }
            io.out(
              `imported concepts=${report.conceptsImported} families=${report.familiesImported} relationships=${report.relationshipsImported} metrics=${report.metricsImported} preserved_certified=${report.preservedCertified}`,
            );
            return 0;
          } catch (error) {
            const msg = errorText(error);
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "ontology",
                  "error",
                  { subcommand: "import" as const, file: filePath, error: "import_failed" },
                  { error: { code: "import_failed", message: msg } },
                ),
              );
            } else {
              io.err(`error: ${clean(msg)}`);
            }
            return 1;
          } finally {
            store.close();
          }
        },
        { retrieval: "none" },
      );
    }

    throw new UsageError(this.usage);
  },
};
