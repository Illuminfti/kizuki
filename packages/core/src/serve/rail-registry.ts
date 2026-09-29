import type { Database } from "bun:sqlite";
import { BUILTIN_RAILS } from "./builtin-rails";
import type { RailDefinition } from "./rail-definition";
import { listSchedules, seedSchedules } from "./schema";
import type { RailSpec, ScheduleRow } from "./types";

export { defineRail } from "./rail-definition";
export type { PendingWork, RailDefinition, RailRunContext, RailWorkProbe } from "./rail-definition";

/**
 * Extension rails ship as their own module with one `defineRail` export
 * (imported from `rail-definition.ts`), then one import and one line here,
 * under their own slot marker. Nothing else in `serve/` names them: schedules,
 * one-shot passes, receipts, doctor and qualification all read this registry.
 */
const EXTENSION_RAILS: readonly RailDefinition[] = [
  // slot: backup
  // slot: verify
];

const SHIPPED: readonly RailDefinition[] = [...BUILTIN_RAILS, ...EXTENSION_RAILS];

const registered = new Map<string, RailDefinition>();
for (const rail of SHIPPED) {
  if (registered.has(rail.id)) throw new Error(`duplicate rail id: ${rail.id}`);
  registered.set(rail.id, rail);
}

/** Every registered rail, in registration order: the shipped rails, then extension rails, then runtime registrations. */
export function listRails(): readonly RailDefinition[] {
  return [...registered.values()];
}

export function railDefinition(id: string): RailDefinition | undefined {
  return registered.get(id);
}

export function isRailId(value: string): boolean {
  return registered.has(value);
}

/** Seed a schedule for every registered rail. `initServe` seeds only the shipped ones. */
export function seedRailSchedules(db: Database): void {
  const specs: RailSpec[] = listRails().map((rail) => ({ rail: rail.id, period_s: rail.period_s, jitter_s: rail.jitter_s, enabled: true }));
  seedSchedules(db, specs);
}

/** The schedule rows of the registered rails. */
export function railSchedules(db: Database): ScheduleRow[] {
  return listSchedules(db, isRailId);
}

/**
 * Register a rail at runtime, for tests and embedders. Shipped rails belong in
 * `EXTENSION_RAILS`. Returns the function that removes it again.
 */
export function registerRail(rail: RailDefinition): () => void {
  if (registered.has(rail.id)) throw new Error(`duplicate rail id: ${rail.id}`);
  registered.set(rail.id, rail);
  return () => { if (registered.get(rail.id) === rail) registered.delete(rail.id); };
}

function period(seconds: number): string {
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["min", 60]] as const) {
    if (seconds % size === 0) return `${seconds / size} ${unit}`;
  }
  return `${seconds} s`;
}

function notes(rail: RailDefinition): string[] {
  return [
    ...(rail.idle_period_s === undefined ? [] : [`backs off to ${period(rail.idle_period_s)} while it has no configured work`]),
    ...(rail.slot_hour === undefined ? [] : ["due at a configured UTC hour"]),
    ...(rail.artifact === undefined ? [] : ["always keeps its receipt"]),
    ...(rail.recover_canon === false ? ["runs while a canon write is held"] : []),
    ...(rail.degrades_on_findings === true ? ["ends degraded to report findings"] : []),
  ];
}

/** The operator table of the shipped rails. A test keeps `docs/world/f5.md` equal to it. */
export function renderRailsTable(): string {
  const rows = SHIPPED.map((rail) => {
    const extra = notes(rail);
    const what = extra.length === 0 ? rail.summary : `${rail.summary} (${extra.join("; ")})`;
    const judged = rail.expects_output ? "work waiting" : "staleness and failure";
    return `| \`${rail.id}\` | ${period(rail.period_s)} | ${rail.jitter_s} s | ${judged} | ${what} |`;
  });
  return ["| Rail | Period | Jitter | Judged by | What it does |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}
