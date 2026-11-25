import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OWNER, listCanonPagesReport, serveSearch } from "@kizuki/core";
import {
  EXPERIENCE_OUTCOMES,
  ExperienceBank,
  MEMT_MODEL_FAMILIES,
  MEMT_PROTOCOL_VERSION,
  MEMT_SENSITIVITIES,
  MEMT_SNAPSHOT_FORMAT,
  MemTClient,
  MemTCustodyError,
  SnapshotCustodyRegistry,
  createMemtEngine,
  fuseHybridRecall,
  isMemtSensitivity,
  loadMemtConfig,
  validateMemTSnapshotFile,
  withinSensitivityCeiling,
  type ExperienceOutcome,
  type MemTCapabilities,
  type MemTIdentity,
  type MemTModelFamily,
  type MemtEngine,
  type MemtSensitivity,
  type MemtSnapshotRecord,
  type MemtSnapshotTaintState,
  type System2EvidenceHit,
} from "@kizuki/memt";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { clean, errorText, jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const TAINT_STATES = ["clean", "stale", "purged_invalidated"] as const;

export interface DoctorMemtReport {
  mode: "native-gpu" | "local-hybrid";
  gpu_backend: "online" | "offline";
  gpu_configured: boolean;
  endpoint_host: string | null;
  model: string | null;
  protocol: string | null;
  epoch: string | null;
  experiences: number;
  uninternalized: number;
  snapshots: number;
  clean_snapshots: number;
  stale_snapshots: number;
  invalidated_snapshots: number;
  detail: string;
}

function safeEndpointHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function safeRedactedUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readLocalMemtCounts(registryPath: string): {
  experiences: { total: number; uninternalized: number };
  snapshots: { total: number; clean: number; stale: number; purgedInvalidated: number };
  snapshotList: MemtSnapshotRecord[];
} {
  if (!existsSync(registryPath)) {
    return {
      experiences: { total: 0, uninternalized: 0 },
      snapshots: { total: 0, clean: 0, stale: 0, purgedInvalidated: 0 },
      snapshotList: [],
    };
  }
  const db = new Database(registryPath, { readonly: true });
  try {
    const experiences = new ExperienceBank({ db });
    const snapshots = new SnapshotCustodyRegistry({ db });
    return {
      experiences: experiences.countExperiences(),
      snapshots: snapshots.countSnapshots(),
      snapshotList: snapshots.listSnapshots(),
    };
  } finally {
    db.close();
  }
}

/**
 * Strictly read-only inspection for `kizuki doctor` and `kizuki memt status`.
 * Never creates `.kizuki/memt/registry.sqlite` on an untouched vault and never
 * echoes API keys or credentials.
 */
export async function inspectMemtForDoctor(
  vaultPath: string,
  env: Record<string, string | undefined>,
): Promise<DoctorMemtReport> {
  const config = loadMemtConfig(vaultPath, env);
  const counts = readLocalMemtCounts(config.registryPath);
  const endpointHost = safeEndpointHost(config.url);
  const gpuConfigured = config.enabled && config.url !== null;

  let gpuOnline = false;
  let identity: MemTIdentity | null = null;
  let capabilities: MemTCapabilities | null = null;

  if (gpuConfigured && config.url !== null) {
    const timeoutMs = Math.min(config.probeTimeoutMs, 800);
    const client = new MemTClient({
      baseUrl: config.url,
      ...(config.apiKey !== null ? { apiKey: config.apiKey } : {}),
      probeTimeoutMs: timeoutMs,
      timeoutMs,
    });
    try {
      capabilities = await client.getCapabilities({ timeoutMs });
      identity = await client.getIdentity({ timeoutMs });
      gpuOnline = true;
    } catch {
      gpuOnline = false;
    }
  }

  const mode = gpuOnline ? "native-gpu" : "local-hybrid";
  const gpuBackend = gpuOnline ? "online" : "offline";
  const model = identity?.model ?? config.model;
  const detail =
    `memt native layer: mode=${mode} gpu=${gpuBackend}` +
    (model === null ? "" : ` model=${clean(model)}`) +
    (endpointHost === null ? "" : ` endpoint=${clean(endpointHost)}`) +
    ` experiences=${counts.experiences.total} uninternalized=${counts.experiences.uninternalized}` +
    ` snapshots=${counts.snapshots.total}` +
    (counts.snapshots.purgedInvalidated > 0
      ? ` invalidated=${counts.snapshots.purgedInvalidated}`
      : "");

  return {
    mode,
    gpu_backend: gpuBackend,
    gpu_configured: gpuConfigured,
    endpoint_host: endpointHost,
    model,
    protocol: capabilities?.protocol ?? null,
    epoch: capabilities?.epoch ?? null,
    experiences: counts.experiences.total,
    uninternalized: counts.experiences.uninternalized,
    snapshots: counts.snapshots.total,
    clean_snapshots: counts.snapshots.clean,
    stale_snapshots: counts.snapshots.stale,
    invalidated_snapshots: counts.snapshots.purgedInvalidated,
    detail,
  };
}

function parsePositiveLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new UsageError(`invalid --limit (expected 1..${max})`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`invalid --limit (expected 1..${max})`);
  }
  return value;
}

function parseConfidenceOption(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(`invalid ${flagName} (expected 0..1)`);
  }
  return value;
}

function parseSensitivityOption(
  raw: string | undefined,
  fallback: MemtSensitivity,
  flagName: string,
): MemtSensitivity {
  if (raw === undefined) return fallback;
  if (!isMemtSensitivity(raw)) {
    throw new UsageError(`invalid ${flagName} (expected ${MEMT_SENSITIVITIES.join("|")})`);
  }
  return raw;
}

function parseOutcomeOption(
  raw: string | undefined,
  fallback: ExperienceOutcome,
): ExperienceOutcome {
  if (raw === undefined) return fallback;
  if (!(EXPERIENCE_OUTCOMES as readonly string[]).includes(raw)) {
    throw new UsageError(`invalid --outcome (expected ${EXPERIENCE_OUTCOMES.join("|")})`);
  }
  return raw as ExperienceOutcome;
}

function parseCitationsOption(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function purgedEventIdsFromVaultDb(db: Database): string[] {
  const hasTable =
    db
      .query<{ ok: number }, []>(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='event_purges' LIMIT 1",
      )
      .get() !== null;
  if (!hasTable) return [];
  return db
    .query<{ event_id: string }, []>("SELECT DISTINCT event_id FROM event_purges")
    .all()
    .map(row => row.event_id);
}

function latestEventWatermark(db: Database): string {
  const hasEvents =
    db
      .query<{ ok: number }, []>(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='events' LIMIT 1",
      )
      .get() !== null;
  if (!hasEvents) return new Date().toISOString();
  return (
    db
      .query<{ accepted_at: string }, []>(
        "SELECT accepted_at FROM events ORDER BY accepted_at DESC, event_id DESC LIMIT 1",
      )
      .get()?.accepted_at ?? new Date().toISOString()
  );
}

function mapCoreSensitivity(raw: unknown): MemtSensitivity {
  return isMemtSensitivity(raw) ? raw : "private";
}

export const MEMT_SCHEMA = {
  options: [
    "--domain",
    "--scope-key",
    "--partition",
    "--ceiling",
    "--sensitivity",
    "--limit",
    "--condition",
    "--recommendation",
    "--verification",
    "--outcome",
    "--confidence",
    "--min-confidence",
    "--citation",
    "--taint",
    "--out",
    "--name",
    "--url",
    "--model",
  ],
  flags: [
    "--json",
    "--dry-run",
    "--uninternalized",
    "--no-synthesis",
    "--include-canon-summaries",
    "--require-online",
  ],
  defaults: {
    "--ceiling": "private",
    "--sensitivity": "work",
    "--limit": "10",
    "--outcome": "observed",
  },
  bounds: {
    "--ceiling": "public|work|personal|private",
    "--sensitivity": "public|work|personal|private",
    "--limit": "1..100",
    "--outcome": "verified|observed|failed|superseded",
    "--confidence": "0..1",
    "--min-confidence": "0..1",
    "--taint": "clean|stale|purged_invalidated",
    "--model": "memt-nano|memt-flash|memt-pro",
  },
} as const satisfies CommandHelpSchema;

export const memtCommand: Command = {
  name: "memt",
  usage:
    "memt <status|recall|experience|sync|snapshot|deploy-check> [options] [--json]",
  summary:
    "inspect, query, record experiences, sync, and verify snapshots in the MemT-1.0 native memory layer",
  schema: MEMT_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...MEMT_SCHEMA.options],
      flags: [...MEMT_SCHEMA.flags],
    });
    const [subcommand, ...rest] = parsed.positionals;
    if (subcommand === undefined) throw new UsageError(this.usage);
    const asJson = parsed.flags.has("--json");

    if (subcommand === "status") {
      if (rest.length !== 0) throw new UsageError("memt status [--json]");
      return withReadVault(
        io,
        async ctx => {
          const config = loadMemtConfig(ctx.vaultPath, io.env);
          const counts = readLocalMemtCounts(config.registryPath);
          const endpoint = safeRedactedUrl(config.url);
          const gpuConfigured = config.enabled && config.url !== null;

          let gpuOnline = false;
          let identity: MemTIdentity | null = null;
          let capabilities: MemTCapabilities | null = null;
          let probeError: string | null = null;

          if (gpuConfigured && config.url !== null) {
            const client = new MemTClient({
              baseUrl: config.url,
              ...(config.apiKey !== null ? { apiKey: config.apiKey } : {}),
              probeTimeoutMs: config.probeTimeoutMs,
              timeoutMs: config.probeTimeoutMs,
            });
            try {
              capabilities = await client.getCapabilities({ timeoutMs: config.probeTimeoutMs });
              identity = await client.getIdentity({ timeoutMs: config.probeTimeoutMs });
              gpuOnline = true;
            } catch (error) {
              gpuOnline = false;
              probeError = errorText(error);
            }
          }

          const mode = gpuOnline ? "native-gpu" : "local-hybrid";
          const gpuBackend = gpuOnline ? "online" : "offline";
          const payload = {
            subcommand: "status" as const,
            mode,
            gpu_backend: gpuBackend,
            gpu_configured: gpuConfigured,
            enabled: config.enabled,
            endpoint,
            api_key_configured: config.apiKey !== null,
            configured_model: config.model,
            default_partition: config.defaultPartition,
            identity,
            capabilities,
            last_probe_error: probeError,
            experiences: counts.experiences,
            snapshots: {
              ...counts.snapshots,
              partitions: counts.snapshotList,
            },
          };

          if (asJson) {
            io.out(jsonEnvelope("memt", "ok", payload));
            return 0;
          }
          io.out(`mode=${mode} gpu_backend=${gpuBackend} configured=${gpuConfigured ? "yes" : "no"}`);
          io.out(`endpoint=${endpoint ?? "none"}`);
          if (identity !== null) {
            io.out(
              `identity model=${clean(identity.model)} checkpoint=${clean(identity.checkpoint_id)} sha256=${clean(identity.config_sha256)}`,
            );
          }
          if (capabilities !== null) {
            io.out(
              `capabilities protocol=${clean(capabilities.protocol)} format=${clean(capabilities.snapshot_format)} epoch=${clean(capabilities.epoch)} chunk_tokens=${capabilities.chunk_tokens} max_commit_tokens=${capabilities.max_commit_tokens}`,
            );
          }
          if (probeError !== null) {
            io.out(`probe_note=${clean(probeError)}`);
          }
          io.out(
            `experiences total=${counts.experiences.total} uninternalized=${counts.experiences.uninternalized}`,
          );
          io.out(
            `snapshots total=${counts.snapshots.total} clean=${counts.snapshots.clean} stale=${counts.snapshots.stale} purged_invalidated=${counts.snapshots.purgedInvalidated}`,
          );
          for (const snap of counts.snapshotList) {
            io.out(
              `partition ${clean(snap.partition_key)} ceiling=${snap.sensitivity_ceiling} taint=${snap.taint_state} snapshot=${clean(snap.snapshot_name)} watermark=${clean(snap.event_watermark)}`,
            );
          }
          return 0;
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "recall") {
      if (rest.length !== 1 || rest[0] === undefined || rest[0].trim().length === 0) {
        throw new UsageError(
          "memt recall <query> [--domain D] [--ceiling public|work|personal|private] [--limit N] [--json]",
        );
      }
      const query = rest[0];
      const domain = parsed.options.get("--domain");
      const scopeKey = parsed.options.get("--scope-key");
      const partitionKey = parsed.options.get("--partition");
      const ceiling = parseSensitivityOption(parsed.options.get("--ceiling"), "private", "--ceiling");
      const limit = parsePositiveLimit(parsed.options.get("--limit"), 10, 50);
      const includeSynthesis = !parsed.flags.has("--no-synthesis");

      return withReadVault(
        io,
        async ctx => {
          const system2Hits: System2EvidenceHit[] = [];
          const searchDegraded: string[] = [];
          try {
            const envelope = await serveSearch(
              {
                db: ctx.db,
                vaultPath: ctx.vaultPath,
                principal: OWNER,
                ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
              },
              { query, scope: "all", limit },
            );
            for (const [index, chunk] of envelope.canon.entries()) {
              const sens = mapCoreSensitivity(chunk.sensitivity);
              if (!withinSensitivityCeiling(sens, ceiling)) continue;
              system2Hits.push({
                id: `page:${chunk.page_id}`,
                kind: "page",
                title: chunk.title,
                text: chunk.excerpt,
                score: 1 / (index + 1),
                sensitivity: sens,
                taint: chunk.taint,
                authority: chunk.authority ?? "model_inference",
                citations: [`page:${chunk.path}`, ...chunk.sources],
              });
            }
            for (const [index, chunk] of envelope.quoted.entries()) {
              const sens = mapCoreSensitivity(chunk.sensitivity);
              if (!withinSensitivityCeiling(sens, ceiling)) continue;
              system2Hits.push({
                id: `event:${chunk.event_id}`,
                kind: "event",
                title: `${chunk.connector_id} ${chunk.kind}`,
                text: chunk.text,
                score: 1 / (index + 1),
                sensitivity: sens,
                taint: "quoted",
                authority: "connector_evidence",
                citations: [`event:${chunk.event_id}`],
              });
            }
            searchDegraded.push(...(envelope.data?.degraded ?? []));
          } catch {
            searchDegraded.push("system2-search-unavailable");
          }

          const config = loadMemtConfig(ctx.vaultPath, io.env);
          const hasRegistry = existsSync(config.registryPath);
          const gpuConfigured = config.enabled && config.url !== null;

          if (!hasRegistry && !gpuConfigured) {
            const fused = fuseHybridRecall({
              system2Hits,
              experienceHits: [],
              sensitivityCeiling: ceiling,
              mode: "local-hybrid",
              degraded: searchDegraded,
              limit,
              rrfK: config.rrfK,
            });
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "memt",
                  fused.degraded.length === 0 ? "ok" : "degraded",
                  { subcommand: "recall", query, ceiling, ...fused },
                  { degraded: [...fused.degraded] },
                ),
              );
              return 0;
            }
            io.out(`mode=${fused.mode} hits=${fused.items.length} system2=${fused.system2Count} experiences=${fused.experienceCount}`);
            for (const item of fused.items) {
              io.out(`${item.source}:${item.kind} [${item.trustTag}] (${item.sensitivity}) ${clean(item.text)}`);
            }
            return 0;
          }

          const engine = createMemtEngine(ctx.vaultPath, { env: io.env });
          try {
            const purgedIds = purgedEventIdsFromVaultDb(ctx.db);
            if (purgedIds.length > 0) engine.purgeSources(purgedIds);

            const recalled = await engine.recall({
              query,
              sensitivityCeiling: ceiling,
              ...(domain !== undefined ? { domain } : {}),
              ...(scopeKey !== undefined ? { scopeKey } : {}),
              ...(partitionKey !== undefined ? { partitionKey } : {}),
              system2Hits,
              limit,
              includeSynthesis,
            });
            const allDegraded = [...new Set([...searchDegraded, ...recalled.degraded])];
            const payload = {
              subcommand: "recall" as const,
              query,
              ceiling,
              ...recalled,
              degraded: allDegraded,
            };
            if (asJson) {
              io.out(
                jsonEnvelope(
                  "memt",
                  allDegraded.length === 0 ? "ok" : "degraded",
                  payload,
                  { degraded: allDegraded },
                ),
              );
              return 0;
            }
            io.out(
              `mode=${recalled.mode} hits=${recalled.items.length} system2=${recalled.system2Count} experiences=${recalled.experienceCount}`,
            );
            if (recalled.synthesis !== null) {
              io.out(`synthesis (${recalled.synthesis.source}, ${recalled.synthesis.trustTag}): ${clean(recalled.synthesis.text)}`);
            }
            for (const item of recalled.items) {
              io.out(
                `${item.source}:${item.kind} [${item.trustTag}] (${item.sensitivity}) ${clean(item.text)} citations=${item.citations.map(clean).join(",")}`,
              );
            }
            return 0;
          } finally {
            await engine.close();
          }
        },
        { retrieval: "optional" },
      );
    }

    if (subcommand === "experience") {
      const [action, ...expArgs] = rest;
      if (action === undefined || !["add", "list", "search", "verify"].includes(action)) {
        throw new UsageError("memt experience <add|list|search|verify> [options] [--json]");
      }

      if (action === "add") {
        if (expArgs.length !== 0) {
          throw new UsageError(
            "memt experience add --domain D --condition C --recommendation R [--scope-key S] [--verification V] [--sensitivity L] [--outcome O] [--confidence N] [--citation REF] [--json]",
          );
        }
        const domain = parsed.options.get("--domain");
        const condition = parsed.options.get("--condition");
        const recommendation = parsed.options.get("--recommendation");
        if (domain === undefined || condition === undefined || recommendation === undefined) {
          throw new UsageError(
            "memt experience add requires --domain, --condition, and --recommendation",
          );
        }
        const scopeKey = parsed.options.get("--scope-key") ?? "general";
        const verification = parsed.options.get("--verification");
        const sensitivity = parseSensitivityOption(
          parsed.options.get("--sensitivity"),
          "work",
          "--sensitivity",
        );
        const outcome = parseOutcomeOption(parsed.options.get("--outcome"), "observed");
        const confidence = parseConfidenceOption(parsed.options.get("--confidence"), "--confidence");
        const citations = parseCitationsOption(parsed.options.get("--citation"));

        return withReadVault(
          io,
          async ctx => {
            const engine = createMemtEngine(ctx.vaultPath, { env: io.env });
            try {
              const recorded = engine.experiences.recordExperience({
                domain,
                scope_key: scopeKey,
                sensitivity,
                condition,
                recommendation,
                ...(verification !== undefined ? { verification } : {}),
                outcome,
                ...(confidence !== undefined ? { confidence } : {}),
                citations,
              });
              const payload = {
                subcommand: "experience.add" as const,
                deduplicated: recorded.deduplicated,
                merged_into_id: recorded.mergedIntoId ?? null,
                experience: recorded.experience,
              };
              if (asJson) io.out(jsonEnvelope("memt", "ok", payload));
              else {
                io.out(
                  `experience id=${recorded.experience.id} domain=${clean(recorded.experience.domain)}/${clean(recorded.experience.scope_key)} outcome=${recorded.experience.outcome} deduplicated=${recorded.deduplicated ? "yes" : "no"}`,
                );
              }
              return 0;
            } finally {
              await engine.close();
            }
          },
          { retrieval: "none" },
        );
      }

      if (action === "list") {
        if (expArgs.length !== 0) {
          throw new UsageError(
            "memt experience list [--domain D] [--ceiling L] [--limit N] [--uninternalized] [--json]",
          );
        }
        const domain = parsed.options.get("--domain");
        const ceiling = parseSensitivityOption(parsed.options.get("--ceiling"), "private", "--ceiling");
        const limit = parsePositiveLimit(parsed.options.get("--limit"), 50, 200);
        const onlyUninternalized = parsed.flags.has("--uninternalized");

        return withReadVault(
          io,
          async ctx => {
            const config = loadMemtConfig(ctx.vaultPath, io.env);
            if (!existsSync(config.registryPath)) {
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "ok", {
                    subcommand: "experience.list",
                    experiences: [],
                    total: 0,
                  }),
                );
              } else io.out("0 experiences");
              return 0;
            }
            const db = new Database(config.registryPath, { readonly: true });
            try {
              const bank = new ExperienceBank({ db });
              const list = onlyUninternalized
                ? bank.getUninternalizedExperiences({
                    ...(domain !== undefined ? { domain } : {}),
                    sensitivityCeiling: ceiling,
                    limit,
                  })
                : bank.listExperiences({
                    ...(domain !== undefined ? { domain } : {}),
                    sensitivityCeiling: ceiling,
                    limit,
                  });
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "ok", {
                    subcommand: "experience.list",
                    experiences: list,
                    total: list.length,
                  }),
                );
              } else if (list.length === 0) {
                io.out("0 experiences");
              } else {
                for (const exp of list) {
                  io.out(
                    `experience ${exp.id} ${clean(exp.domain)}/${clean(exp.scope_key)} outcome=${exp.outcome} conf=${exp.confidence.toFixed(2)} sensitivity=${exp.sensitivity} internalized=${exp.internalized_in_snapshot ?? "no"}`,
                  );
                }
              }
              return 0;
            } finally {
              db.close();
            }
          },
          { retrieval: "none" },
        );
      }

      if (action === "search") {
        if (expArgs.length !== 1 || expArgs[0] === undefined) {
          throw new UsageError(
            "memt experience search <query> [--domain D] [--scope-key S] [--ceiling L] [--limit N] [--json]",
          );
        }
        const query = expArgs[0];
        const domain = parsed.options.get("--domain");
        const scopeKey = parsed.options.get("--scope-key");
        const ceiling = parseSensitivityOption(parsed.options.get("--ceiling"), "private", "--ceiling");
        const limit = parsePositiveLimit(parsed.options.get("--limit"), 10, 100);

        return withReadVault(
          io,
          async ctx => {
            const config = loadMemtConfig(ctx.vaultPath, io.env);
            if (!existsSync(config.registryPath)) {
              if (asJson) {
                io.out(jsonEnvelope("memt", "ok", { subcommand: "experience.search", query, hits: [] }));
              } else io.out("0 hits");
              return 0;
            }
            const db = new Database(config.registryPath, { readonly: true });
            try {
              const bank = new ExperienceBank({ db });
              const hits = bank.searchExperiences({
                query,
                sensitivityCeiling: ceiling,
                ...(domain !== undefined ? { domain } : {}),
                ...(scopeKey !== undefined ? { scopeKey } : {}),
                limit,
              });
              if (asJson) {
                io.out(jsonEnvelope("memt", "ok", { subcommand: "experience.search", query, hits }));
              } else if (hits.length === 0) {
                io.out("0 hits");
              } else {
                for (const hit of hits) {
                  io.out(
                    `hit ${hit.experience.id} score=${hit.score.toFixed(4)} ${clean(hit.experience.domain)}/${clean(hit.experience.scope_key)} (${hit.experience.outcome}) ${clean(hit.experience.recommendation)}`,
                  );
                }
              }
              return 0;
            } finally {
              db.close();
            }
          },
          { retrieval: "none" },
        );
      }

      // action === "verify"
      if (expArgs.length !== 1 || expArgs[0] === undefined) {
        throw new UsageError(
          "memt experience verify <id> [--verification V] [--confidence N] [--citation REF] [--outcome O] [--json]",
        );
      }
      const expId = expArgs[0];
      const verification = parsed.options.get("--verification");
      const confidence = parseConfidenceOption(parsed.options.get("--confidence"), "--confidence");
      const addCitations = parseCitationsOption(parsed.options.get("--citation"));
      const outcome = parseOutcomeOption(parsed.options.get("--outcome"), "verified");

      return withReadVault(
        io,
        async ctx => {
          const engine = createMemtEngine(ctx.vaultPath, { env: io.env });
          try {
            const markOpts = {
              ...(verification !== undefined ? { verification } : {}),
              ...(confidence !== undefined ? { confidence } : {}),
              ...(addCitations.length > 0 ? { addCitations } : {}),
            };
            const updated =
              outcome === "verified"
                ? engine.experiences.markVerified(expId, markOpts)
                : engine.experiences.recordOutcome(expId, outcome, markOpts);
            if (updated === null) {
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "error", {
                    subcommand: "experience.verify",
                    id: expId,
                    error: "not_found",
                  }),
                );
              } else io.err(`error: experience not found: ${clean(expId)}`);
              return 1;
            }
            if (asJson) {
              io.out(
                jsonEnvelope("memt", "ok", {
                  subcommand: "experience.verify",
                  experience: updated,
                }),
              );
            } else {
              io.out(
                `verified id=${updated.id} outcome=${updated.outcome} confidence=${updated.confidence.toFixed(2)} use_count=${updated.use_count}`,
              );
            }
            return 0;
          } finally {
            await engine.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "sync") {
      if (rest.length !== 0) {
        throw new UsageError(
          "memt sync [--dry-run] [--domain D] [--partition P] [--ceiling L] [--min-confidence N] [--include-canon-summaries] [--json]",
        );
      }
      const dryRun = parsed.flags.has("--dry-run");
      const domainFilter = parsed.options.get("--domain");
      const explicitPartition = parsed.options.get("--partition");
      const ceiling = parseSensitivityOption(parsed.options.get("--ceiling"), "private", "--ceiling");
      const minConfidence = parseConfidenceOption(
        parsed.options.get("--min-confidence"),
        "--min-confidence",
      );
      const includeCanonSummaries = parsed.flags.has("--include-canon-summaries");

      return withReadVault(
        io,
        async ctx => {
          const engine = createMemtEngine(ctx.vaultPath, { env: io.env });
          try {
            const purgedIds = purgedEventIdsFromVaultDb(ctx.db);
            const purged =
              !dryRun && purgedIds.length > 0
                ? engine.purgeSources(purgedIds)
                : {
                    snapshots: { invalidatedPartitions: [] as readonly string[], checkedSources: purgedIds.length },
                    experiences: { purgedIds: [] as readonly string[], purgedCount: 0 },
                  };

            const status = await engine.probe({ force: true });
            const pending = engine.experiences.getUninternalizedExperiences({
              ...(domainFilter !== undefined ? { domain: domainFilter } : {}),
              sensitivityCeiling: ceiling,
              ...(minConfidence !== undefined ? { minConfidence } : {}),
              limit: 500,
            });

            const domains =
              domainFilter !== undefined
                ? [domainFilter]
                : [...new Set(pending.map(item => item.domain))].sort();

            const canonSummaries: string[] = [];
            const canonSourceIds: string[] = [];
            if (includeCanonSummaries) {
              const pages = listCanonPagesReport(ctx.vaultPath).pages;
              for (const page of pages.slice(0, 64)) {
                const sens = mapCoreSensitivity(page.data["sensitivity"]);
                if (!withinSensitivityCeiling(sens, ceiling)) continue;
                const title =
                  typeof page.data["title"] === "string" ? page.data["title"] : page.relPath;
                const snippet = page.body.trim().slice(0, 400);
                if (snippet.length > 0) {
                  canonSummaries.push(`[Canon ${page.relPath}] ${title}: ${snippet}`);
                }
                const sources = page.data["sources"];
                if (Array.isArray(sources)) {
                  for (const src of sources) {
                    if (typeof src === "string") canonSourceIds.push(src);
                  }
                }
              }
              if (domains.length === 0 && canonSummaries.length > 0) {
                domains.push(engine.config.defaultPartition);
              }
            }

            const plannedPartitions = domains.map(dom => ({
              domain: dom,
              partition_key: explicitPartition ?? dom,
              pending_experiences: pending.filter(item => item.domain === dom).length,
            }));

            if (dryRun) {
              const payload = {
                subcommand: "sync" as const,
                dry_run: true,
                mode: status.mode,
                gpu_backend: status.gpu_backend,
                pending_experiences: pending.length,
                canon_summaries: canonSummaries.length,
                planned_partitions: plannedPartitions,
                purged_source_candidates: purgedIds.length,
              };
              if (asJson) io.out(jsonEnvelope("memt", "ok", payload));
              else {
                io.out(
                  `Dry run: mode=${status.mode} gpu_backend=${status.gpu_backend} pending_experiences=${pending.length} partitions=${plannedPartitions.length}`,
                );
              }
              return 0;
            }

            if (status.mode !== "native-gpu") {
              const payload = {
                subcommand: "sync" as const,
                dry_run: false,
                mode: status.mode,
                gpu_backend: status.gpu_backend,
                internalized: false,
                pending_experiences: pending.length,
                internalized_partitions: [],
                purged,
                note: "MemT GPU server is offline; experiences remain active in local-hybrid SQLite bank",
              };
              if (asJson) io.out(jsonEnvelope("memt", "ok", payload));
              else {
                io.out(
                  `mode=local-hybrid gpu_backend=offline pending_experiences=${pending.length} (GPU server offline; local-hybrid bank active)`,
                );
              }
              return 0;
            }

            const watermark = latestEventWatermark(ctx.db);
            const results = [];
            for (const plan of plannedPartitions) {
              const res = await engine.internalizePartition({
                partitionKey: plan.partition_key,
                domain: plan.domain,
                sensitivityCeiling: ceiling,
                ...(minConfidence !== undefined ? { minConfidence } : {}),
                ...(canonSummaries.length > 0 ? { summaryTexts: canonSummaries } : {}),
                ...(canonSourceIds.length > 0 ? { sourceIds: canonSourceIds } : {}),
                eventWatermark: watermark,
              });
              results.push(res);
            }

            const experiencesInternalized = results.reduce(
              (sum, item) => sum + item.experienceIds.length,
              0,
            );
            const tokensCommitted = results.reduce((sum, item) => sum + item.tokensCommitted, 0);
            const payload = {
              subcommand: "sync" as const,
              dry_run: false,
              mode: "native-gpu" as const,
              gpu_backend: "online" as const,
              internalized: results.some(item => item.internalized),
              experiences_internalized: experiencesInternalized,
              tokens_committed: tokensCommitted,
              internalized_partitions: results,
              purged,
            };
            if (asJson) io.out(jsonEnvelope("memt", "ok", payload));
            else {
              io.out(
                `mode=native-gpu internalized_experiences=${experiencesInternalized} tokens_committed=${tokensCommitted} partitions=${results.length}`,
              );
            }
            return 0;
          } finally {
            await engine.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "snapshot") {
      const [action, ...snapArgs] = rest;
      if (action === undefined || !["list", "verify", "export"].includes(action)) {
        throw new UsageError("memt snapshot <list|verify|export> [options] [--json]");
      }

      if (action === "list") {
        if (snapArgs.length !== 0) {
          throw new UsageError("memt snapshot list [--taint clean|stale|purged_invalidated] [--json]");
        }
        const rawTaint = parsed.options.get("--taint");
        if (rawTaint !== undefined && !(TAINT_STATES as readonly string[]).includes(rawTaint)) {
          throw new UsageError(`invalid --taint (expected ${TAINT_STATES.join("|")})`);
        }
        return withReadVault(
          io,
          async ctx => {
            const config = loadMemtConfig(ctx.vaultPath, io.env);
            const counts = readLocalMemtCounts(config.registryPath);
            const filtered =
              rawTaint === undefined
                ? counts.snapshotList
                : counts.snapshotList.filter(
                    item => item.taint_state === (rawTaint as MemtSnapshotTaintState),
                  );
            if (asJson) {
              io.out(
                jsonEnvelope("memt", "ok", {
                  subcommand: "snapshot.list",
                  counts: counts.snapshots,
                  snapshots: filtered,
                }),
              );
            } else if (filtered.length === 0) {
              io.out("0 snapshots");
            } else {
              for (const snap of filtered) {
                io.out(
                  `snapshot partition=${clean(snap.partition_key)} name=${clean(snap.snapshot_name)} taint=${snap.taint_state} ceiling=${snap.sensitivity_ceiling} watermark=${clean(snap.event_watermark)}`,
                );
              }
            }
            return 0;
          },
          { retrieval: "none" },
        );
      }

      if (action === "verify") {
        if (snapArgs.length > 1) {
          throw new UsageError("memt snapshot verify [<file-or-partition>] [--ceiling L] [--json]");
        }
        const target = snapArgs[0];
        const ceilingOpt = parsed.options.get("--ceiling");
        const requiredCeiling =
          ceilingOpt === undefined
            ? undefined
            : parseSensitivityOption(ceilingOpt, "private", "--ceiling");

        // Direct .safetensors file verification works even outside a vault when target is an existing file path.
        if (target !== undefined && (target.endsWith(".safetensors") || existsSync(target))) {
          const filePath = resolve(target);
          const validation = validateMemTSnapshotFile(filePath);
          if (asJson) {
            io.out(
              jsonEnvelope("memt", validation.ok ? "ok" : "error", {
                subcommand: "snapshot.verify",
                target: filePath,
                ...validation,
              }),
            );
          } else if (validation.ok) {
            io.out(
              `verified file=${clean(filePath)} format=${validation.format} identity=${clean(validation.identity)} layers=${validation.layers.length}`,
            );
          } else {
            io.err(`invalid snapshot ${clean(filePath)}: ${validation.errors.join("; ")}`);
          }
          return validation.ok ? 0 : 1;
        }

        return withReadVault(
          io,
          async ctx => {
            const config = loadMemtConfig(ctx.vaultPath, io.env);
            const counts = readLocalMemtCounts(config.registryPath);
            const candidates =
              target === undefined
                ? counts.snapshotList
                : counts.snapshotList.filter(item => item.partition_key === target);
            if (target !== undefined && candidates.length === 0) {
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "error", {
                    subcommand: "snapshot.verify",
                    partition_key: target,
                    ok: false,
                    errors: [`partition '${target}' not found`],
                  }),
                );
              } else io.err(`error: snapshot partition not found: ${clean(target)}`);
              return 1;
            }

            const db = existsSync(config.registryPath)
              ? new Database(config.registryPath, { readonly: true })
              : null;
            try {
              const registry = db === null ? null : new SnapshotCustodyRegistry({ db });
              const results = candidates.map(record => {
                const filePath = join(config.snapshotDir, record.snapshot_name);
                try {
                  registry?.assertLoadable(record.partition_key, {
                    allowStale: true,
                    ...(requiredCeiling !== undefined
                      ? { requiredSensitivityCeiling: requiredCeiling }
                      : {}),
                    filePath,
                  });
                  const fileCheck = validateMemTSnapshotFile(filePath);
                  return {
                    partition_key: record.partition_key,
                    snapshot_name: record.snapshot_name,
                    taint_state: record.taint_state,
                    ok: fileCheck.ok,
                    errors: fileCheck.ok ? ([] as readonly string[]) : fileCheck.errors,
                  };
                } catch (error) {
                  return {
                    partition_key: record.partition_key,
                    snapshot_name: record.snapshot_name,
                    taint_state: record.taint_state,
                    ok: false,
                    errors: [
                      error instanceof MemTCustodyError ? `${error.code}: ${error.message}` : errorText(error),
                    ],
                  };
                }
              });
              const allOk = results.every(item => item.ok);
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", allOk ? "ok" : "error", {
                    subcommand: "snapshot.verify",
                    ok: allOk,
                    checked: results.length,
                    results,
                  }),
                );
              } else if (results.length === 0) {
                io.out("0 snapshots to verify");
              } else {
                for (const item of results) {
                  if (item.ok) {
                    io.out(
                      `verified partition=${clean(item.partition_key)} snapshot=${clean(item.snapshot_name)} taint=${item.taint_state}`,
                    );
                  } else {
                    io.err(
                      `failed partition=${clean(item.partition_key)}: ${item.errors.join("; ")}`,
                    );
                  }
                }
              }
              return allOk ? 0 : 1;
            } finally {
              db?.close();
            }
          },
          { retrieval: "none" },
        );
      }

      // action === "export"
      if (snapArgs.length !== 0) {
        throw new UsageError(
          "memt snapshot export [--partition P] [--domain D] [--ceiling L] [--out PATH] [--name FILE] [--json]",
        );
      }
      const partitionKey = parsed.options.get("--partition") ?? parsed.options.get("--domain") ?? "default";
      const domain = parsed.options.get("--domain") ?? partitionKey;
      const ceiling = parseSensitivityOption(parsed.options.get("--ceiling"), "private", "--ceiling");
      const outPath = parsed.options.get("--out");
      const snapshotName = parsed.options.get("--name");

      return withReadVault(
        io,
        async ctx => {
          const engine: MemtEngine = createMemtEngine(ctx.vaultPath, { env: io.env });
          try {
            const purgedIds = purgedEventIdsFromVaultDb(ctx.db);
            if (purgedIds.length > 0) engine.purgeSources(purgedIds);

            const status = await engine.probe({ force: true });
            let exportedPath: string | null = null;
            let record: MemtSnapshotRecord | null = null;

            if (status.mode === "native-gpu") {
              const syncRes = await engine.internalizePartition({
                partitionKey,
                domain,
                sensitivityCeiling: ceiling,
                ...(snapshotName !== undefined ? { snapshotName } : {}),
                eventWatermark: latestEventWatermark(ctx.db),
              });
              if (syncRes.snapshotPath !== undefined && syncRes.snapshotRecord !== undefined) {
                exportedPath = syncRes.snapshotPath;
                record = syncRes.snapshotRecord;
              }
            }

            if (exportedPath === null) {
              const existing = engine.snapshots.getSnapshot(partitionKey);
              if (existing !== null) {
                const candidatePath = join(engine.config.snapshotDir, existing.snapshot_name);
                record = engine.snapshots.assertLoadable(partitionKey, {
                  requiredSensitivityCeiling: ceiling,
                  filePath: candidatePath,
                });
                exportedPath = candidatePath;
              }
            }

            if (exportedPath === null || record === null) {
              const msg =
                status.mode === "native-gpu"
                  ? `no experiences or existing snapshot available for partition '${partitionKey}'`
                  : `MemT GPU backend is offline and no clean local snapshot exists for partition '${partitionKey}'`;
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "error", {
                    subcommand: "snapshot.export",
                    partition_key: partitionKey,
                    error: msg,
                  }),
                );
              } else io.err(`error: ${clean(msg)}`);
              return 1;
            }

            let finalPath = exportedPath;
            if (outPath !== undefined) {
              finalPath = resolve(outPath);
              mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
              copyFileSync(exportedPath, finalPath);
              chmodSync(finalPath, 0o600);
            }
            const validation = validateMemTSnapshotFile(finalPath);
            if (!validation.ok) {
              if (asJson) {
                io.out(
                  jsonEnvelope("memt", "error", {
                    subcommand: "snapshot.export",
                    partition_key: partitionKey,
                    errors: validation.errors,
                  }),
                );
              } else io.err(`error: exported snapshot failed validation: ${validation.errors.join("; ")}`);
              return 1;
            }

            if (asJson) {
              io.out(
                jsonEnvelope("memt", "ok", {
                  subcommand: "snapshot.export",
                  partition_key: partitionKey,
                  snapshot_path: finalPath,
                  snapshot_record: record,
                  layers: validation.layers.length,
                }),
              );
            } else {
              io.out(
                `exported partition=${clean(partitionKey)} path=${clean(finalPath)} format=${validation.format} layers=${validation.layers.length}`,
              );
            }
            return 0;
          } catch (error) {
            if (asJson) {
              io.out(
                jsonEnvelope("memt", "error", {
                  subcommand: "snapshot.export",
                  partition_key: partitionKey,
                  error: errorText(error),
                }),
              );
            } else io.err(`error: ${clean(errorText(error))}`);
            return 1;
          } finally {
            await engine.close();
          }
        },
        { retrieval: "none" },
      );
    }

    if (subcommand === "deploy-check") {
      if (rest.length !== 0) {
        throw new UsageError(
          "memt deploy-check [--url URL] [--model memt-nano|memt-flash|memt-pro] [--require-online] [--json]",
        );
      }
      const rawModel = parsed.options.get("--model") ?? "memt-nano";
      if (!(MEMT_MODEL_FAMILIES as readonly string[]).includes(rawModel)) {
        throw new UsageError(`invalid --model (expected ${MEMT_MODEL_FAMILIES.join("|")})`);
      }
      const modelFamily = rawModel as MemTModelFamily;
      const requireOnline = parsed.flags.has("--require-online");

      return withReadVault(
        io,
        async ctx => {
          const config = loadMemtConfig(ctx.vaultPath, io.env);
          const targetUrl = parsed.options.get("--url") ?? config.url ?? "http://127.0.0.1:30000";
          const redactedUrl = safeRedactedUrl(targetUrl) ?? "http://127.0.0.1:30000";

          const repoDeployDir = resolve(import.meta.dir, "../../../../deploy/memt-sglang");
          const scriptByModel: Record<MemTModelFamily, string> = {
            "memt-nano": "launch-nano-2gpu.sh",
            "memt-flash": "launch-flash-8gpu.sh",
            "memt-pro": "launch-pro-8gpu.sh",
          };
          const launchScript = join(repoDeployDir, scriptByModel[modelFamily]);
          const tunnelUnit = join(repoDeployDir, "kizuki-memt-tunnel.service");
          const scriptsPresent = existsSync(launchScript) && existsSync(tunnelUnit);

          let endpointOnline = false;
          let protocolCompatible = false;
          let identity: MemTIdentity | null = null;
          let capabilities: MemTCapabilities | null = null;
          let probeError: string | null = null;

          try {
            const client = new MemTClient({
              baseUrl: targetUrl,
              ...(config.apiKey !== null ? { apiKey: config.apiKey } : {}),
              probeTimeoutMs: config.probeTimeoutMs,
              timeoutMs: config.probeTimeoutMs,
            });
            capabilities = await client.getCapabilities({ timeoutMs: config.probeTimeoutMs });
            identity = await client.getIdentity({ timeoutMs: config.probeTimeoutMs });
            endpointOnline = true;
            protocolCompatible =
              capabilities.protocol === MEMT_PROTOCOL_VERSION &&
              capabilities.snapshot_format === MEMT_SNAPSHOT_FORMAT &&
              identity.memt_runtime["enabled"] !== false;
          } catch (error) {
            probeError = errorText(error);
          }

          const commands = {
            gpu_pod_launch: `./deploy/memt-sglang/${scriptByModel[modelFamily]}`,
            ssh_tunnel:
              "ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:30000:127.0.0.1:30000 root@<runpod-host> -p <ssh-port>",
            systemd_tunnel_enable:
              "systemctl --user enable --now kizuki-memt-tunnel.service",
            serve_toml_snippet: `[memt]\nenabled = true\nurl = "${redactedUrl}"\nmodel = "${modelFamily}"`,
          };

          const ready = endpointOnline && protocolCompatible;
          const ok = !requireOnline || ready;
          const payload = {
            subcommand: "deploy-check" as const,
            ready,
            endpoint: redactedUrl,
            endpoint_online: endpointOnline,
            protocol_compatible: protocolCompatible,
            model_family: modelFamily,
            deploy_kit_present: scriptsPresent,
            identity,
            capabilities,
            probe_error: probeError,
            commands,
          };

          if (asJson) {
            io.out(jsonEnvelope("memt", ok ? "ok" : "error", payload));
          } else {
            io.out(
              `memt deploy-check ready=${ready ? "yes" : "no"} endpoint=${clean(redactedUrl)} online=${endpointOnline ? "yes" : "no"} deploy_kit=${scriptsPresent ? "present" : "missing"}`,
            );
            if (probeError !== null) io.out(`probe: ${clean(probeError)} (local-hybrid fallback remains active)`);
            io.out(`1. GPU pod (${modelFamily}): ${commands.gpu_pod_launch}`);
            io.out(`2. SSH tunnel: ${commands.ssh_tunnel}`);
            io.out(`3. Systemd tunnel: ${commands.systemd_tunnel_enable}`);
          }
          return ok ? 0 : 1;
        },
        { retrieval: "none" },
      );
    }

    throw new UsageError(this.usage);
  },
};
