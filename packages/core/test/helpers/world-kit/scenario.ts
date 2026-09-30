/**
 * Builds the state of the concept design fixture in a real ledger: its
 * sources and grants, its two scoped principals and its captured records, and
 * executes the controls that have a product operation today (source
 * revocation, exact raw purge, grant narrowing). A control that needs a
 * workstream that has not landed throws `ScenarioDeferred` naming its owner;
 * it is never skipped silently and never faked.
 *
 * Capture time is the ledger's wall clock (`accepted_at` is set inside the
 * capture transaction), so the fixture's record times are exposed as data and
 * only claim-level recorded time is driven, through the clock.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate, setGrant, type Principal } from "../../../src/agents";
import { initGraph } from "../../../src/graph/schema";
import { openLedger } from "../../../src/ledger/db";
import { accept } from "../../../src/ledger/ledger";
import { purgeEvents } from "../../../src/ledger/purge";
import { revokeSourceGrant } from "../../../src/ledger/source-grants";
import { initSearch } from "../../../src/search/schema";
import type { ServeContext } from "../../../src/serving/types";
import { dispatchServeTool } from "../../../src/serving/dispatch";
import { validEvent } from "../../fixtures";
import { testClock, type TestClock } from "../clock";
import { tempVault } from "../vault";
import { enrollSource } from "../world-seed";

const FIXTURE = join(import.meta.dir, "../../../../../rfcs/fixtures/world-concept-design.json");

interface FixtureSource { readonly id: string }
interface FixtureRecord {
  readonly id: string;
  readonly source_ref: string;
  readonly content: string;
  readonly available_at: string;
  readonly record_created_at: string | null;
  readonly core_admission_seq: number;
  readonly raw_subject_refs: readonly string[];
}
interface FixtureSubject { readonly id: string; readonly raw_subject: string }
interface FixturePrincipal { readonly id: string; readonly permitted_subject_refs: readonly string[] }
interface FixtureControl {
  readonly id: string;
  readonly kind: string;
  readonly source_ref?: string;
  readonly selected_record_refs?: readonly string[];
  readonly principal_ref?: string;
  readonly removed_subject_refs?: readonly string[];
}
interface Fixture {
  readonly input: {
    readonly initial_policy_at: string;
    readonly sources: readonly FixtureSource[];
    readonly source_subjects: readonly FixtureSubject[];
    readonly principals: readonly FixturePrincipal[];
    readonly records: readonly FixtureRecord[];
    readonly controls: readonly FixtureControl[];
  };
}

/** The workstream that will give a fixture control a product operation. */
const DEFERRED_CONTROL_OWNER: Readonly<Record<string, string>> = {
  owner_identity_confirmation: "IDENT",
  prepare_consolidation_job: "CONSOL",
  attempt_stale_consolidation_commit: "CONSOL",
  owner_exact_claim_correction: "CORRECT",
};

export class ScenarioDeferred extends Error {
  override readonly name = "ScenarioDeferred";
  constructor(
    readonly control: string,
    readonly owner: string,
  ) {
    super(`control ${control} waits for workstream ${owner}`);
  }
}

export interface ScenarioPrincipal {
  readonly name: string;
  readonly principal: Principal;
}

export interface ConceptScenario {
  readonly db: Database;
  readonly vaultPath: string;
  readonly clock: TestClock;
  /** Source ref (s1..s4) to its enrolled source key. */
  readonly sources: ReadonlyMap<string, string>;
  /** Record ref (r01..r06) to its captured event id. */
  readonly records: ReadonlyMap<string, string>;
  /** Fixture principal (g1, g2) to its enrolled agent. */
  readonly principals: ReadonlyMap<string, ScenarioPrincipal>;
  /** Every control id of the fixture, in fixture order. */
  readonly controls: readonly string[];
  /** A serving context for the owner or a fixture principal. */
  ctx(who: "owner" | string): ServeContext;
  /** Raw records a principal can read through the timeline tool, in ledger order. */
  visibleRecords(who: "owner" | string): Promise<string[]>;
  /** Source record ids still in the ledger, sorted. */
  retainedRecords(): string[];
  applyControl(id: string): Promise<void>;
  dispose(): void;
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
}

export async function conceptScenario(): Promise<ConceptScenario> {
  const { input } = fixture();
  const vault = tempVault("kizuki-scenario-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);
    const clock = testClock(input.initial_policy_at.replace("Z", ".000Z"));
    const sources = new Map<string, string>();
    for (const source of input.sources) {
      sources.set(source.id, enrollSource(db, `world.scenario.${source.id}`, "private"));
    }
    const subjectToken = new Map(input.source_subjects.map((subject) => [subject.id, subject.raw_subject]));
    const records = new Map<string, string>();
    for (const record of [...input.records].sort((a, b) => a.core_admission_seq - b.core_admission_seq)) {
      const sourceKey = sources.get(record.source_ref)!;
      const accepted = accept(
        db,
        {
          ...validEvent(),
          connector_id: `world.scenario.${record.source_ref}`,
          source_record_id: record.id,
          kind: "note",
          text: record.content,
          observed_at: record.available_at,
          sensitivity_hint: "private",
          subjects: record.raw_subject_refs.map((ref) => ({ subject_id: subjectToken.get(ref)!, role: "about" })),
          attachments: [],
          metadata: {},
        },
        { source: { source_key: sourceKey, expected_revision: 1 } },
      );
      if (accepted.status !== "stored") throw new Error(`record ${record.id} was not stored: ${JSON.stringify(accepted)}`);
      records.set(record.id, accepted.event.event_id);
    }
    const principals = new Map<string, ScenarioPrincipal>();
    for (const entry of input.principals) {
      const name = `fixture-${entry.id}`;
      const agent = addAgent(db, name, {
        ...OWNER_AGENT_GRANT,
        ceiling: "private",
        subjects: entry.permitted_subject_refs.map((ref) => subjectToken.get(ref)!),
      });
      const principal = authenticate(db, agent.token);
      if (principal === null) throw new Error(`principal ${entry.id} did not authenticate`);
      principals.set(entry.id, { name, principal });
    }
    const ctx = (who: string): ServeContext => {
      if (who === "owner") return { db, vaultPath: vault.path, principal: OWNER };
      const found = principals.get(who);
      if (found === undefined) throw new Error(`no fixture principal ${who}`);
      return { db, vaultPath: vault.path, principal: found.principal };
    };
    const byEvent = new Map([...records].map(([ref, eventId]) => [eventId, ref]));
    return {
      db,
      vaultPath: vault.path,
      clock,
      sources,
      records,
      principals,
      controls: input.controls.map((control) => control.id),
      ctx,
      async visibleRecords(who) {
        const served = await dispatchServeTool(ctx(who), "timeline", { limit: 50 });
        const quoted = served.quoted as { event_id: string }[];
        return quoted.map((entry) => byEvent.get(entry.event_id)).filter((ref): ref is string => ref !== undefined).sort();
      },
      retainedRecords() {
        return db
          .query<{ source_record_id: string }, []>("SELECT source_record_id FROM events ORDER BY source_record_id")
          .all()
          .map((row) => row.source_record_id);
      },
      async applyControl(id) {
        const control = input.controls.find((entry) => entry.id === id);
        if (control === undefined) throw new Error(`no fixture control ${id}`);
        if (control.kind === "source_use_revocation") {
          revokeSourceGrant(db, {
            source_key: sources.get(control.source_ref!)!,
            expected_revision: 1,
            operation_id: `scenario-${id}`,
          });
        } else if (control.kind === "exact_raw_event_purge") {
          for (const ref of control.selected_record_refs!) {
            purgeEvents(db, vault.path, { event_id: records.get(ref)! }, `scenario-${id}`);
          }
        } else if (control.kind === "grant_narrowing") {
          const entry = principals.get(control.principal_ref!)!;
          const removed = new Set(control.removed_subject_refs!.map((ref) => subjectToken.get(ref)!));
          const kept = entry.principal.grant.subjects?.filter((subject) => !removed.has(subject)) ?? [];
          setGrant(db, entry.name, { subjects: [...kept] });
        } else {
          const owner = DEFERRED_CONTROL_OWNER[control.kind];
          if (owner === undefined) throw new Error(`the concept fixture has a control kind with no product operation and no owner: ${control.kind}`);
          throw new ScenarioDeferred(id, owner);
        }
      },
      dispose() {
        db.close();
        vault.dispose();
      },
    };
  } catch (error) {
    db.close();
    vault.dispose();
    throw error;
  }
}
