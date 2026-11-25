import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperienceBank,
  cosineSimilarity,
  fuseHybridRecall,
  withinSensitivityCeiling,
  type ExperienceOutcome,
  type MemtSensitivity,
  type System2EvidenceHit,
} from "../src/index";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 384;
const DOMAINS = [
  "ops",
  "engineering",
  "security",
  "deploy",
  "database",
  "networking",
  "observability",
  "release",
] as const;
const SCOPES = ["primary", "canary", "failover", "migration", "tuning"] as const;
const SENSITIVITIES: readonly MemtSensitivity[] = [
  "public",
  "work",
  "personal",
  "private",
];
const OUTCOMES: readonly ExperienceOutcome[] = [
  "verified",
  "observed",
  "failed",
  "superseded",
];

function normalizeVec(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i]! * v[i]!;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i]! * inv;
  return out;
}

function randomUnitVector(rng: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) {
    v[i] = rng() + rng() + rng() - 1.5;
  }
  return normalizeVec(v);
}

function perturbVector(
  base: Float32Array,
  rng: () => number,
  noiseScale: number,
): Float32Array {
  const noise = randomUnitVector(rng);
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) {
    out[i] = base[i]! + noise[i]! * noiseScale;
  }
  return normalizeVec(out);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

interface GoldSpec {
  readonly topic: string;
  readonly domain: string;
  readonly scope: string;
  readonly sensitivity: MemtSensitivity;
  readonly condition: string;
  readonly recommendation: string;
  readonly verification: string;
  readonly nlQuery: string;
  readonly paraphraseQuery: string;
  readonly citation: string;
}

const GOLD_SPECS: readonly GoldSpec[] = [
  {
    topic: "pg-pool",
    domain: "database",
    scope: "primary",
    sensitivity: "work",
    condition: "Postgres connection pool exhausts under sudden write spike",
    recommendation: "Enable PgBouncer transaction pooling and cap idle backend lifetime",
    verification: "Verify active client sockets stay below 60 percent",
    nlQuery: "how do we fix exhausting postgres connections during sudden write spikes?",
    paraphraseQuery: "relational store saturation under heavy traffic bursts",
    citation: "event:gold_pg_pool",
  },
  {
    topic: "k8s-crashloop",
    domain: "deploy",
    scope: "canary",
    sensitivity: "public",
    condition: "Kubernetes pod enters crashloop backoff right after rolling deploy",
    recommendation: "Inspect liveness probe initialDelaySeconds and rollback faulty image tag",
    verification: "Confirm pods reach Ready state with zero restarts",
    nlQuery: "what should I do when kubernetes pods are restarting after rolling deployments?",
    paraphraseQuery: "container orchestrator repeatedly terminating newly released workloads",
    citation: "event:gold_k8s_crash",
  },
  {
    topic: "tls-cert",
    domain: "security",
    scope: "primary",
    sensitivity: "work",
    condition: "Ingress TLS certificate rotation fails with ACME challenge timeout",
    recommendation: "Verify DNS-01 propagation records and renew cert-manager issuer secret",
    verification: "Run openssl s_client and inspect updated certificate expiry",
    nlQuery: "why is our ingress certificate rotating failing with challenge timeouts?",
    paraphraseQuery: "encrypted gateway handshake credential renewal stalled",
    citation: "event:gold_tls_cert",
  },
  {
    topic: "sqlite-wal",
    domain: "database",
    scope: "tuning",
    sensitivity: "public",
    condition: "SQLite WAL checkpoint stalls because a long read transaction holds lock",
    recommendation: "Split read queries into short snapshots and run PRAGMA wal_checkpoint(TRUNCATE)",
    verification: "Check WAL file size returns under 4 megabytes",
    nlQuery: "how to resolve stalled sqlite checkpointing when readers are holding locks?",
    paraphraseQuery: "embedded write-ahead log growing unbounded due to lingering cursor",
    citation: "event:gold_sqlite_wal",
  },
  {
    topic: "redis-evict",
    domain: "ops",
    scope: "tuning",
    sensitivity: "work",
    condition: "Redis cache evicts hot session keys during batch backfill",
    recommendation: "Switch maxmemory-policy to allkeys-lfu and isolate batch keys in separate DB",
    verification: "Measure cache hit ratio recovers above 94 percent",
    nlQuery: "why is redis evicting active sessions while batch backfilling runs?",
    paraphraseQuery: "in-memory store dropping live user tokens under bulk ingest",
    citation: "event:gold_redis_evict",
  },
  {
    topic: "dns-flapping",
    domain: "networking",
    scope: "failover",
    sensitivity: "work",
    condition: "CoreDNS upstream lookup latency spikes during node drain",
    recommendation: "Enable nodelocal dns cache and configure graceful endpoint termination delay",
    verification: "Confirm p99 DNS resolution stays under 5 milliseconds",
    nlQuery: "how do I stop coredns lookups from spiking when draining nodes?",
    paraphraseQuery: "hostname resolution slowing down during cluster host evacuation",
    citation: "event:gold_dns_flap",
  },
  {
    topic: "otel-drop",
    domain: "observability",
    scope: "primary",
    sensitivity: "public",
    condition: "OpenTelemetry collector drops trace spans when queue saturates",
    recommendation: "Raise memory_limiter spike limit and enable batch processor compression",
    verification: "Verify otelcol_exporter_send_failed_spans stays at zero",
    nlQuery: "why is the opentelemetry collector dropping traced spans under saturation?",
    paraphraseQuery: "telemetry ingestion pipeline discarding distributed diagnostic records",
    citation: "event:gold_otel_drop",
  },
  {
    topic: "canary-rollback",
    domain: "release",
    scope: "canary",
    sensitivity: "work",
    condition: "Canary release triggers elevated HTTP 502 gateway errors",
    recommendation: "Halt progressive traffic shift and drain canary target group immediately",
    verification: "Confirm edge 5xx rate returns below 0.05 percent",
    nlQuery: "what to do if canary releases are triggering elevated gateway errors?",
    paraphraseQuery: "staged rollout causing upstream proxy failures for small traffic slice",
    citation: "event:gold_canary_rb",
  },
  {
    topic: "oom-worker",
    domain: "engineering",
    scope: "tuning",
    sensitivity: "personal",
    condition: "Node background worker terminates with heap out of memory during export",
    recommendation: "Stream CSV rows through async iterators instead of buffering full array",
    verification: "Monitor RSS stays flat below 512 megabytes on 1M row export",
    nlQuery: "how to prevent background workers from terminating with memory errors while exporting?",
    paraphraseQuery: "async job runner crashing from excessive RAM allocation during report dump",
    citation: "event:gold_oom_worker",
  },
  {
    topic: "ssh-perms",
    domain: "security",
    scope: "failover",
    sensitivity: "private",
    condition: "SSH bastion refuses key authentication after account restore",
    recommendation: "Enforce chmod 700 on ssh config dir and chmod 600 on authorized_keys file",
    verification: "Test non-interactive ssh login succeeds without password prompt",
    nlQuery: "why is bastion ssh refusing key authenticating after restoring accounts?",
    paraphraseQuery: "remote shell jump host rejecting public-key handshake after backup recovery",
    citation: "event:gold_ssh_perms",
  },
  {
    topic: "kafka-lag",
    domain: "ops",
    scope: "primary",
    sensitivity: "work",
    condition: "Kafka consumer group lag climbs rapidly after partition rebalance",
    recommendation: "Enable cooperative-sticky assignor and increase max.poll.interval.ms",
    verification: "Verify consumer lag drains smoothly without repeated rebalances",
    nlQuery: "how to fix kafka consumers lagging after partitions are rebalancing?",
    paraphraseQuery: "event stream subscribers falling behind following shard reassignment",
    citation: "event:gold_kafka_lag",
  },
  {
    topic: "gh-flaky-ci",
    domain: "engineering",
    scope: "primary",
    sensitivity: "public",
    condition: "Parallel test runner fails intermittently with SQLite database locked error",
    recommendation: "Isolate each test suite in a unique 0700 temporary directory and enable busy_timeout",
    verification: "Run full test suite five times consecutively with zero lock errors",
    nlQuery: "how do we stop parallel tests from failing with locked database errors?",
    paraphraseQuery: "concurrent automated specs colliding on shared file storage state",
    citation: "event:gold_flaky_ci",
  },
];

const NOISE_VERBS = [
  "configure", "monitor", "restart", "audit", "throttle", "drain", "compact",
  "rotate", "verify", "benchmark", "profile", "rebalance", "snapshot", "archive",
];
const NOISE_NOUNS = [
  "scheduler", "broker", "gateway", "indexer", "shard", "replica", "cache",
  "webhook", "pipeline", "queue", "ledger", "vault", "proxy", "controller",
  "daemon", "collector", "router", "registry", "validator", "worker",
];
const NOISE_ADJS = [
  "stale", "saturated", "degraded", "fragmented", "unresponsive", "throttled",
  "skewed", "orphaned", "corrupted", "overloaded", "ephemeral", "unindexed",
];

describe("MemT ExperienceBank & Hybrid Fusion 2,000+ 384-d benchmark suite", () => {
  test("delivers high recall, low latency, MMR diversity, semantic dedup, corroboration, and zero sensitivity leaks at 2,000+ scale", () => {
    const dir = mkdtempSync(join(tmpdir(), "kizuki-memt-bench-"));
    chmodSync(dir, 0o700);
    const dbPath = join(dir, "bench.sqlite");
    const rng = makeRng(20261124);
    const bank = new ExperienceBank({ dbPath });

    const goldIds = new Map<string, string>();
    const goldVectors = new Map<string, Float32Array>();
    const vectorById = new Map<string, Float32Array>();

    try {
      // 1. Populate 2,048 experiences with 384-d Float32 embeddings
      for (const g of GOLD_SPECS) {
        const vec = randomUnitVector(rng);
        goldVectors.set(g.topic, vec);
        const res = bank.recordExperience({
          domain: g.domain,
          scope_key: g.scope,
          sensitivity: g.sensitivity,
          condition: g.condition,
          recommendation: g.recommendation,
          verification: g.verification,
          outcome: "verified",
          confidence: 0.92,
          citations: [g.citation],
          embedding: vec,
        });
        goldIds.set(g.topic, res.experience.id);
        vectorById.set(res.experience.id, vec);

        // Add 3 near-duplicate sibling-scope variants to stress MMR diversity
        for (let copy = 1; copy <= 3; copy += 1) {
          const nearVec = perturbVector(vec, rng, 0.28);
          const dup = bank.recordExperience({
            domain: g.domain,
            scope_key: `${g.scope}-mirror-${copy}`,
            sensitivity: g.sensitivity,
            condition: `${g.condition} (mirror ${copy})`,
            recommendation: `${g.recommendation} (copy ${copy})`,
            verification: g.verification,
            outcome: "observed",
            confidence: 0.88 - copy * 0.02,
            citations: [`event:dup_${g.topic}_${copy}`],
            embedding: nearVec,
          });
          vectorById.set(dup.experience.id, nearVec);
        }
      }

      const domainCentroids = new Map<string, Float32Array>();
      for (const d of DOMAINS) domainCentroids.set(d, randomUnitVector(rng));

      for (let i = 0; i < 2000; i += 1) {
        const domain = DOMAINS[i % DOMAINS.length]!;
        const scope = `${SCOPES[Math.floor(i / DOMAINS.length) % SCOPES.length]!}-${i % 15}`;
        const sensitivity = SENSITIVITIES[i % SENSITIVITIES.length]!;
        const outcome =
          OUTCOMES[i % 10 < 5 ? 0 : i % 10 < 8 ? 1 : i % 10 === 8 ? 2 : 3]!;
        const v1 = NOISE_VERBS[Math.floor(rng() * NOISE_VERBS.length)]!;
        const v2 = NOISE_VERBS[Math.floor(rng() * NOISE_VERBS.length)]!;
        const n1 = NOISE_NOUNS[Math.floor(rng() * NOISE_NOUNS.length)]!;
        const n2 = NOISE_NOUNS[Math.floor(rng() * NOISE_NOUNS.length)]!;
        const adj = NOISE_ADJS[Math.floor(rng() * NOISE_ADJS.length)]!;
        const vec = perturbVector(domainCentroids.get(domain)!, rng, 1.8);
        const rec = bank.recordExperience({
          domain,
          scope_key: scope,
          sensitivity,
          condition: `Incident #${i}: ${adj} ${n1} affects ${domain} ${n2} throughput`,
          recommendation: `Step ${i}: ${v1} ${n1} buffer and ${v2} ${n2} queue limits`,
          verification: `Check ${n1} telemetry stays nominal`,
          outcome,
          confidence: 0.55 + (i % 40) * 0.01,
          citations: [`event:bg_${i}`],
          embedding: vec,
        });
        vectorById.set(rec.experience.id, vec);
      }

      expect(bank.countExperiences().total).toBe(2048);

      // 2. Semantic paraphrase deduplication (cosine >= 0.92, low lexical Jaccard)
      let semanticMerged = 0;
      for (const g of GOLD_SPECS) {
        const paraVec = perturbVector(goldVectors.get(g.topic)!, rng, 0.2);
        const res = bank.recordExperience({
          domain: g.domain,
          scope_key: g.scope,
          sensitivity: g.sensitivity,
          condition: g.paraphraseQuery,
          recommendation: `Remediate ${g.topic} via standard runbook checklist`,
          outcome: "observed",
          confidence: 0.86,
          citations: [`event:para_${g.topic}`],
          embedding: paraVec,
        });
        if (res.deduplicated && res.mergedIntoId === goldIds.get(g.topic)) {
          semanticMerged += 1;
        }
      }
      expect(semanticMerged).toBe(GOLD_SPECS.length);
      expect(bank.countExperiences().total).toBe(2048);

      // 3. Natural-language lexical search (stopwords + morphological stems)
      let lexR1 = 0;
      let lexR5 = 0;
      for (const g of GOLD_SPECS) {
        const targetId = goldIds.get(g.topic)!;
        const hits = bank.searchExperiences({
          query: g.nlQuery,
          sensitivityCeiling: "private",
          limit: 5,
        });
        const rank = hits.findIndex((h) => h.experience.id === targetId);
        if (rank === 0) lexR1 += 1;
        if (rank >= 0 && rank < 5) lexR5 += 1;
      }
      expect(lexR1 / GOLD_SPECS.length).toBeGreaterThanOrEqual(0.95);
      expect(lexR5 / GOLD_SPECS.length).toBe(1);

      // 4. Hybrid search + MMR diversity comparison (MMR vs no-MMR)
      // Warm vector cache
      bank.searchExperiences({
        query: "",
        queryVector: goldVectors.get(GOLD_SPECS[0]!.topic)!,
        sensitivityCeiling: "private",
        limit: 5,
      });

      let hybR1 = 0;
      let mmrRedundantPairs = 0;
      let mmrTotalPairs = 0;
      let rawRedundantPairs = 0;
      let rawTotalPairs = 0;
      const pureVecLatencies: number[] = [];

      for (const g of GOLD_SPECS) {
        const targetId = goldIds.get(g.topic)!;
        const qVec = perturbVector(goldVectors.get(g.topic)!, rng, 0.5);

        const mmrHits = bank.searchExperiences({
          query: g.nlQuery,
          queryVector: qVec,
          sensitivityCeiling: "private",
          limit: 5,
        });
        if (mmrHits[0]?.experience.id === targetId) hybR1 += 1;

        const rawHits = bank.searchExperiences({
          query: g.nlQuery,
          queryVector: qVec,
          sensitivityCeiling: "private",
          diversityLambda: 1.0,
          limit: 5,
        });

        const countRedundancy = (hits: typeof mmrHits) => {
          let pairs = 0;
          let red = 0;
          for (let i = 0; i < hits.length; i += 1) {
            const vi = vectorById.get(hits[i]!.experience.id);
            if (!vi) continue;
            for (let j = i + 1; j < hits.length; j += 1) {
              const vj = vectorById.get(hits[j]!.experience.id);
              if (!vj) continue;
              pairs += 1;
              if (cosineSimilarity(vi, vj) >= 0.82) red += 1;
            }
          }
          return { pairs, red };
        };

        const mStats = countRedundancy(mmrHits);
        mmrTotalPairs += mStats.pairs;
        mmrRedundantPairs += mStats.red;
        const rStats = countRedundancy(rawHits);
        rawTotalPairs += rStats.pairs;
        rawRedundantPairs += rStats.red;

        // Pure 384-d vector latency check
        const t0 = performance.now();
        const pureHits = bank.searchExperiences({
          query: "",
          queryVector: qVec,
          sensitivityCeiling: "private",
          limit: 5,
        });
        pureVecLatencies.push(performance.now() - t0);
        expect(pureHits[0]?.experience.id).toBe(targetId);
      }

      expect(hybR1 / GOLD_SPECS.length).toBeGreaterThanOrEqual(0.95);
      const mmrRedundancyRate =
        mmrTotalPairs > 0 ? mmrRedundantPairs / mmrTotalPairs : 0;
      const rawRedundancyRate =
        rawTotalPairs > 0 ? rawRedundantPairs / rawTotalPairs : 0;
      expect(mmrRedundancyRate).toBeLessThanOrEqual(0.05);
      expect(mmrRedundancyRate).toBeLessThan(rawRedundancyRate);

      pureVecLatencies.sort((a, b) => a - b);
      // Pre-normalized packed Float32Array cache keeps 2,048 x 384-d vector search well under 10ms even on loaded CI
      expect(percentile(pureVecLatencies, 0.5)).toBeLessThan(10);

      // 5. Paraphrase + 384-d vector recall (low lexical overlap must not get drowned by accidental 1-word matches)
      let paraR1 = 0;
      for (const g of GOLD_SPECS) {
        const targetId = goldIds.get(g.topic)!;
        const qVec = perturbVector(goldVectors.get(g.topic)!, rng, 0.45);
        const hits = bank.searchExperiences({
          query: g.paraphraseQuery,
          queryVector: qVec,
          sensitivityCeiling: "private",
          limit: 5,
        });
        if (hits[0]?.experience.id === targetId) paraR1 += 1;
      }
      expect(paraR1 / GOLD_SPECS.length).toBeGreaterThanOrEqual(0.9);

      // 6. Strict sensitivity ceiling isolation (0 leaks)
      for (const ceiling of ["public", "work", "personal"] as const) {
        for (const g of GOLD_SPECS) {
          const hits = bank.searchExperiences({
            query: g.nlQuery,
            queryVector: goldVectors.get(g.topic)!,
            sensitivityCeiling: ceiling,
            limit: 10,
          });
          for (const h of hits) {
            expect(withinSensitivityCeiling(h.experience.sensitivity, ceiling)).toBe(true);
          }
        }
      }

      // 7. Hybrid fusion cross-source citation corroboration & outcome reliability
      for (let i = 0; i < GOLD_SPECS.length; i += 1) {
        const g = GOLD_SPECS[i]!;
        const goldRec = bank.getExperience(goldIds.get(g.topic)!)!;
        const s2Hits: System2EvidenceHit[] = [
          {
            id: g.citation,
            kind: "page",
            title: `${g.domain} runbook`,
            text: g.condition,
            score: 0.9,
            sensitivity: g.sensitivity,
            taint: "clean",
            citations: [g.citation],
          },
        ];
        const uncorrNoise = {
          ...goldRec,
          id: `exp_noise_${i}`,
          domain: "misc",
          scope_key: "other",
          outcome: (i % 2 === 0 ? "observed" : "failed") as ExperienceOutcome,
          confidence: 0.95,
          citations: ["event:unrelated_noise"],
        };
        const fused = fuseHybridRecall({
          system2Hits: s2Hits,
          experienceHits: [
            {
              experience: uncorrNoise,
              score: 0.02,
              bm25Rank: 1,
              vectorRank: null,
              cosineSimilarity: null,
            },
            {
              experience: goldRec,
              score: 0.019,
              bm25Rank: 2,
              vectorRank: 1,
              cosineSimilarity: 0.92,
            },
          ],
          sensitivityCeiling: g.sensitivity,
          limit: 5,
        });
        const goldPos = fused.items.findIndex(
          (it) => it.id === `experience:${goldRec.id}`,
        );
        const noisePos = fused.items.findIndex(
          (it) => it.id === `experience:${uncorrNoise.id}`,
        );
        expect(goldPos).toBeGreaterThanOrEqual(0);
        expect(goldPos).toBeLessThan(noisePos);
      }

      // 8. Indexed purgeBySourceRefs removes from SQLite, FTS5, and vector cache immediately
      const purgedTarget = GOLD_SPECS[0]!;
      const purgedId = goldIds.get(purgedTarget.topic)!;
      const purgeRes = bank.purgeBySourceRefs([purgedTarget.citation.replace("event:", "")]);
      expect(purgeRes.purgedIds).toContain(purgedId);
      expect(bank.getExperience(purgedId)).toBeNull();
      const postPurgeHits = bank.searchExperiences({
        query: "",
        queryVector: goldVectors.get(purgedTarget.topic)!,
        sensitivityCeiling: "private",
        limit: 10,
      });
      expect(postPurgeHits.some((h) => h.experience.id === purgedId)).toBe(false);
    } finally {
      bank.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
