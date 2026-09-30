import { embedBackfillPeriod, loadServeConfig } from "./config";
import { embedPendingWork, retrievalPendingWork, syncPendingWork } from "./doctor-rails";
import { requireAtomicExtractReplay } from "./extract";
import { briefPath } from "./notifier-file";
import { defineRail, type RailDefinition } from "./rail-definition";
import { DEFAULT_SYNC_PERIOD_S, EMBED_BACKFILL_IDLE_PERIOD_S } from "./types";


// Execution loads only at run time: ledger initialization reads definitions without loading the daemon.
/** One definition per shipped rail, in the existing doctor and one-shot order. */
export const BUILTIN_RAILS: readonly RailDefinition[] = [
  defineRail({
    id: "sync", period_s: DEFAULT_SYNC_PERIOD_S, jitter_s: 90,
    summary: "Pulls new records from connected sources, extracts claims with the bound model and files them as canon writes.",
    expects_output: true,
    doctor: syncPendingWork,
    // A sync decision is validated before any journal is imported.
    preflight: requireAtomicExtractReplay,
    configured_period_s: (vaultPath) => loadServeConfig(vaultPath).sync_period_s,
    run: async (context) => (await import("./rails")).runSyncRail(context),
  }),
  defineRail({
    id: "retrieval-sweep", period_s: 300, jitter_s: 0,
    summary: "Retries pending retrieval operations and catches the derived indexes up in bounded batches.",
    expects_output: true,
    doctor: retrievalPendingWork,
    run: async (context) => (await import("./rails")).runRetrievalSweep(context),
  }),
  defineRail({
    id: "purge-sweep", period_s: 600, jitter_s: 0,
    summary: "Resumes interrupted purges and reports purge health.",
    expects_output: false,
    recover_canon: false,
    run: async (context) => (await import("./rails")).runPurgeSweep(context),
  }),
  defineRail({
    id: "embed-backfill", period_s: 60, jitter_s: 0,
    summary: "Reports the embedding backlog and adopts the period the embedding configuration asks for.",
    expects_output: true,
    doctor: embedPendingWork,
    idle_period_s: EMBED_BACKFILL_IDLE_PERIOD_S,
    configured_period_s: embedBackfillPeriod,
    run: async (context) => (await import("./rails")).runEmbedBackfill(context),
  }),
  defineRail({
    id: "brief", period_s: 86400, jitter_s: 0,
    summary: "Writes the daily brief page.",
    expects_output: false,
    slot_hour: (config) => config.brief_hour,
    artifact: briefPath,
    run: async (context) => (await import("./rails")).runBrief(context),
  }),
  defineRail({
    id: "doctor-sweep", period_s: 3600, jitter_s: 0,
    summary: "Runs the doctor checks that need no supervisor and reports what failed on its receipt.",
    expects_output: false,
    recover_canon: false,
    degrades_on_findings: true,
    run: async (context) => (await import("./rails")).runDoctorSweep(context),
  }),
  defineRail({
    id: "journal-prune", period_s: 86400, jitter_s: 0,
    summary: "Prunes the run receipt journal by age and size.",
    expects_output: false,
    run: async (context) => (await import("./rails")).runJournalPrune(context),
  }),
];
