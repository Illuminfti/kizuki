// Import this only through rail-registry.ts: the registry and these definitions import each other.
import { embedBackfillPeriod, loadServeConfig } from "./config";
import { embedPendingWork, retrievalPendingWork, syncPendingWork } from "./doctor-rails";
import { requireAtomicExtractReplay } from "./extract";
import { briefPath } from "./notifier-file";
import { defineRail, type RailBehavior, type RailDefinition } from "./rail-definition";
import {
  runBrief,
  runDoctorSweep,
  runEmbedBackfill,
  runJournalPrune,
  runPurgeSweep,
  runRetrievalSweep,
  runSyncRail,
} from "./rails";
import { DEFAULT_RAILS, EMBED_BACKFILL_IDLE_PERIOD_S, type ShippedRailId } from "./types";

/** What each shipped rail does. The record is keyed by id, so a shipped rail without behavior does not compile. */
const BEHAVIOR: Record<ShippedRailId, RailBehavior> = {
  sync: {
    summary: "Pulls new records from connected sources, extracts claims with the bound model and files them as canon writes.",
    expects_output: true,
    doctor: syncPendingWork,
    // A sync decision is validated before any journal is imported.
    preflight: requireAtomicExtractReplay,
    configured_period_s: (vaultPath) => loadServeConfig(vaultPath).sync_period_s,
    run: runSyncRail,
  },
  "retrieval-sweep": {
    summary: "Retries pending retrieval operations and catches the derived indexes up in bounded batches.",
    expects_output: true,
    doctor: retrievalPendingWork,
    run: runRetrievalSweep,
  },
  "purge-sweep": {
    summary: "Resumes interrupted purges and reports purge health.",
    expects_output: false,
    recover_canon: false,
    run: runPurgeSweep,
  },
  "embed-backfill": {
    summary: "Reports the embedding backlog and adopts the period the embedding configuration asks for.",
    expects_output: true,
    doctor: embedPendingWork,
    idle_period_s: EMBED_BACKFILL_IDLE_PERIOD_S,
    configured_period_s: embedBackfillPeriod,
    run: runEmbedBackfill,
  },
  brief: {
    summary: "Writes the daily brief page.",
    expects_output: false,
    slot_hour: (config) => config.brief_hour,
    artifact: briefPath,
    run: runBrief,
  },
  "doctor-sweep": {
    summary: "Runs the doctor checks that need no supervisor and reports what failed on its receipt.",
    expects_output: false,
    recover_canon: false,
    degrades_on_findings: true,
    run: runDoctorSweep,
  },
  "journal-prune": {
    summary: "Prunes the run receipt journal by age and size.",
    expects_output: false,
    run: runJournalPrune,
  },
};

/** The rails the loop ships with, in the order doctor and a one-shot pass list them. */
export const BUILTIN_RAILS: readonly RailDefinition[] = DEFAULT_RAILS.map((spec) =>
  defineRail({ id: spec.rail, period_s: spec.period_s, jitter_s: spec.jitter_s, ...BEHAVIOR[spec.rail] }));
